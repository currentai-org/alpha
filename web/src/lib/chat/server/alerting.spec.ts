import { describe, it, expect, vi, beforeEach } from "vitest";

// alerting.recordProbe reads/writes the alert_state row through getDb() (drizzle) and POSTs via fetch.
// Mock the DB with an in-memory single-row store, stub fetch, and stub firstKey to a fixed webhook so we
// can assert the fire/debounce/recover transitions without a real Postgres or a real Slack call. The real
// schema (a pure table def, no connection) is used so drizzle's eq() works; only the db CLIENT is mocked.
const rows = new Map<string, Record<string, unknown>>();
vi.mock("$lib/chat/server/db/client", () => ({
	getDb: () => ({
		select: () => {
			const all = () => Promise.resolve([...rows.values()]);
			return { from: () => Object.assign(all(), { where: all }) };
		},
		insert: () => ({
			values: (v: { key: string }) => ({
				// recordProbe's upsert is unconditional — it always applies.
				onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
					rows.set(v.key, { ...v, ...set });
					const result = [{ key: v.key }];
					return Object.assign(Promise.resolve(result), {
						returning: () => Promise.resolve(result),
					});
				},
			}),
		}),
	}),
}));

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
vi.stubGlobal("fetch", fetchMock);
// TWO outbound destinations now share this fetch: the Slack webhook and the per-dependency Better Stack
// heartbeats behind the public status page. Resolve them to DIFFERENT URLs so a test can tell which one
// fired — asserting on a raw call count would let a missing Slack post hide behind a heartbeat ping.
const SLACK_URL = "https://hooks.slack.test/triggers/x";
const HB_URL = "https://uptime.test/api/v1/heartbeat/dep";
vi.mock("$lib/chat/server/env/firstKey", () => ({
	firstKey: (_keys: string[], name: string) =>
		name === "betterstackDependencyHeartbeat" ? HB_URL : SLACK_URL,
}));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn() },
	securityLogger: { info: vi.fn(), warn: vi.fn() },
}));

import { recordProbe, recordRateLimitTrip, clearRateLimitTrip, HEARTBEAT_ENV_BY_KEY } from "./alerting";
import { logger } from "$lib/chat/server/logger";

const KEY = "coop:verdict";
const opts = { label: "Coop verdict path", runbook: "runbook line." };
/** Calls to the Slack webhook only — heartbeat pings share the same fetch mock and must not shift the
 *  index that every "what did we say" assertion below depends on. */
const slackCalls = () =>
	(fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([url]) => url === SLACK_URL);
/** Pings to the per-dependency status-page heartbeats. */
const heartbeatCalls = () =>
	(fetchMock.mock.calls as unknown as [string, RequestInit][]).filter(([url]) => url === HB_URL);

const bodyOf = (call: number) => JSON.parse(slackCalls()[call][1].body as string).text as string;

beforeEach(() => {
	rows.clear();
	fetchMock.mockClear();
});

describe("recordProbe", () => {
	it("posts no Slack alert on a healthy probe (nothing to clear)", async () => {
		await recordProbe(KEY, true, opts);
		expect(slackCalls()).toHaveLength(0);
		expect(rows.size).toBe(0); // no row written when there's nothing firing/failing
	});

	it("does not fire below the threshold, then fires once on the 3rd consecutive failure", async () => {
		await recordProbe(KEY, false, opts);
		await recordProbe(KEY, false, opts);
		expect(slackCalls()).toHaveLength(0);
		expect(rows.get(KEY)?.consecutiveFailures).toBe(2);

		await recordProbe(KEY, false, opts); // 3rd → fire
		expect(slackCalls()).toHaveLength(1);
		expect(bodyOf(0)).toContain("DOWN");
		expect(bodyOf(0)).toContain("Coop verdict path");
		expect(rows.get(KEY)?.firing).toBe(true);
	});

	it("logs a delivered alert by its key and never its text, so a later check can confirm the page went out", async () => {
		vi.mocked(logger.info).mockClear();
		for (let i = 0; i < 3; i++) await recordProbe(KEY, false, opts);
		expect(slackCalls()).toHaveLength(1);
		const delivered = vi.mocked(logger.info).mock.calls.filter(([, msg]) => msg === "[alert] delivered");
		expect(delivered).toEqual([[{ alert_key: KEY }, "[alert] delivered"]]);
	});

	it("logs no delivered line when the Slack POST fails", async () => {
		vi.mocked(logger.info).mockClear();
		fetchMock.mockImplementation(async () => new Response("nope", { status: 500 }));
		try {
			for (let i = 0; i < 3; i++) await recordProbe(KEY, false, opts);
		} finally {
			fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
		}
		expect(vi.mocked(logger.info).mock.calls.some(([, msg]) => msg === "[alert] delivered")).toBe(false);
	});

	it("debounces — a 4th consecutive failure does NOT re-fire within the re-alert window", async () => {
		for (let i = 0; i < 4; i++) await recordProbe(KEY, false, opts);
		expect(slackCalls()).toHaveLength(1); // only the threshold crossing
		expect(rows.get(KEY)?.consecutiveFailures).toBe(4);
	});

	it("says DEGRADED, not DOWN, for a dependency whose consumers fail open", async () => {
		const degraded = { ...opts, severity: "degraded" as const };
		for (let i = 0; i < 3; i++) await recordProbe(KEY, false, degraded);
		expect(bodyOf(0)).toContain("DEGRADED");
		expect(bodyOf(0)).not.toContain("DOWN");
	});

	it("posts a single recovery line and resets when it comes back healthy", async () => {
		for (let i = 0; i < 3; i++) await recordProbe(KEY, false, opts); // fire
		fetchMock.mockClear();
		await recordProbe(KEY, true, opts); // recover
		expect(slackCalls()).toHaveLength(1);
		expect(bodyOf(0)).toContain("recovered");
		expect(rows.get(KEY)?.firing).toBe(false);
		expect(rows.get(KEY)?.consecutiveFailures).toBe(0);

		await recordProbe(KEY, true, opts); // already healthy → silent
		expect(slackCalls()).toHaveLength(1);
	});
});

// The public status page is driven by SILENCE: recordProbe pings a per-dependency heartbeat only while
// the dependency is healthy, and Better Stack reds the component when pings stop. So the load-bearing
// assertion is the NEGATIVE one — a test that only proved "healthy pings" would pass forever while an
// unhealthy dependency also pinged, holding a public component green when it should be red.
describe("per-dependency status-page heartbeats", () => {
	it("pings the dependency heartbeat on a healthy probe", async () => {
		await recordProbe(KEY, true, opts);
		expect(heartbeatCalls()).toHaveLength(1);
		expect(heartbeatCalls()[0][1].method).toBe("POST");
	});

	it("WITHHOLDS the ping on an unhealthy probe — silence is what reds the public component", async () => {
		await recordProbe(KEY, false, opts);
		expect(heartbeatCalls()).toHaveLength(0);
		// …and keeps withholding it while the dependency is down, including past the Slack fire threshold
		// (Slack debounces and goes quiet; the heartbeat must NOT quietly resume).
		for (let i = 0; i < 4; i++) await recordProbe(KEY, false, opts);
		expect(heartbeatCalls()).toHaveLength(0);
	});

	it("pings for every probe key that backs a status-page component", async () => {
		// Read from the map itself, not a hand-copied list — a copied list silently stops covering a key
		// added later, and a probe key missing from HEARTBEAT_ENV_BY_KEY would never send a heartbeat.
		const keys = Object.keys(HEARTBEAT_ENV_BY_KEY);
		for (const k of keys) await recordProbe(k, true, opts);
		expect(heartbeatCalls()).toHaveLength(keys.length);
	});

	it("does not ping for a probe key with no component (an unmapped key is a no-op, not an error)", async () => {
		await expect(recordProbe("some:future-probe", true, opts)).resolves.toBeUndefined();
		expect(heartbeatCalls()).toHaveLength(0);
	});

	it("reports healthy even when the alert-state DB is unreachable — the public page is not a function of our own database", async () => {
		const boom = vi.spyOn(rows, "values").mockImplementation(() => {
			throw new Error("pooler down");
		});
		await expect(recordProbe(KEY, true, opts)).resolves.toBeUndefined();
		boom.mockRestore();
		expect(heartbeatCalls()).toHaveLength(1);
	});

	it("is best-effort: a heartbeat that 500s never breaks the warm leg that called it", async () => {
		fetchMock.mockImplementationOnce(async () => new Response("nope", { status: 500 }));
		await expect(recordProbe(KEY, true, opts)).resolves.toBeUndefined();
	});
});

// enforceRequestRateLimits 429s over a trip, and a trip must reach a human rather than
// stay visible only to someone who greps logs. These pin the contract, not just "it compiles". (CUR-1134)
describe("recordRateLimitTrip", () => {
	const RL_KEY = "chat-rate-limit:session:abuser-1";
	const rlOpts = { limitName: "per-session/minute", identity: "abuser-1" };

	it("does not fire below the threshold — a normal retry burst must not page anyone", async () => {
		for (let i = 0; i < 4; i++) await recordRateLimitTrip(RL_KEY, rlOpts);
		expect(slackCalls()).toHaveLength(0);
		expect(rows.get(RL_KEY)?.consecutiveFailures).toBe(4);
	});

	it("fires once on the 5th consecutive trip — THE REGRESSION this ticket exists to prevent", async () => {
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(RL_KEY, rlOpts);
		expect(slackCalls()).toHaveLength(1);
		expect(bodyOf(0)).toContain("per-session/minute");
		expect(bodyOf(0)).toContain("abuser-1");
		expect(bodyOf(0)).toContain("5 times");
	});

	it("debounces — sustained tripping past the threshold posts exactly one alert, not one per trip", async () => {
		for (let i = 0; i < 9; i++) await recordRateLimitTrip(RL_KEY, rlOpts);
		expect(slackCalls()).toHaveLength(1); // only the threshold crossing, not all 9
		expect(rows.get(RL_KEY)?.consecutiveFailures).toBe(9);
	});

	it("never emits a recovery line — a rate limiter has no healthy probe to call back with", async () => {
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(RL_KEY, rlOpts);
		expect(bodyOf(0)).not.toContain("recovered");
	});

	it("is best-effort: an unreachable alert-state DB never surfaces to the caller (rate-limit enforcement must not depend on it)", async () => {
		const boom = vi.spyOn(rows, "values").mockImplementation(() => {
			throw new Error("pooler down");
		});
		await expect(recordRateLimitTrip(RL_KEY, rlOpts)).resolves.toBeUndefined();
		boom.mockRestore();
	});

	// The headline must name the LIMITER that tripped, not hardcode "chat rate limit": a
	// custodial-storage quota trip has nothing to do with chat, and a wrong name sends whoever is paged
	// to the wrong runbook. (CUR-1319)
	it("headlines with the limiter's own name, not a hardcoded 'chat rate limit' — a non-chat limiter must not read as chat", async () => {
		const storageKey = "custodial-storage:quota:user-1";
		const storageOpts = { limitName: "custodial storage quota", identity: "user-1" };
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(storageKey, storageOpts);
		expect(bodyOf(0)).toContain("custodial storage quota");
		expect(bodyOf(0)).not.toContain("chat rate limit");
	});
});

// recordRateLimitTrip's own contract is "never resets" — correct for a rate (a rolling
// window that empties on its own) and wrong for a stock (a state that stays true until something
// clears it, e.g. a full storage quota). clearRateLimitTrip is the decay a stock-backed trigger
// needs so a resolved condition doesn't keep re-firing on every subsequent retry. (CUR-1318)
describe("clearRateLimitTrip", () => {
	const QUOTA_KEY = "custodial-storage:quota:user-1";
	const quotaOpts = { limitName: "custodial storage quota", identity: "user-1" };

	it("resets consecutiveFailures/firing once a trip has actually occurred", async () => {
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(QUOTA_KEY, quotaOpts); // fires, firing=true
		expect(rows.get(QUOTA_KEY)?.firing).toBe(true);

		await clearRateLimitTrip(QUOTA_KEY);

		expect(rows.get(QUOTA_KEY)?.firing).toBe(false);
		expect(rows.get(QUOTA_KEY)?.consecutiveFailures).toBe(0);
	});

	it("THE REGRESSION this exists to prevent: without a clear, retrying against a persistent condition re-fires every threshold crossing forever", async () => {
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(QUOTA_KEY, quotaOpts); // fires once
		expect(slackCalls()).toHaveLength(1);
		// The condition "resolves" (user deleted files) — clear it, matching the real call site.
		await clearRateLimitTrip(QUOTA_KEY);
		fetchMock.mockClear();

		// The condition recurs — this must be treated as a FRESH episode, not a continuation of a
		// counter that never stopped climbing.
		for (let i = 0; i < 4; i++) await recordRateLimitTrip(QUOTA_KEY, quotaOpts);
		expect(slackCalls()).toHaveLength(0); // below threshold again — the clear actually took
		await recordRateLimitTrip(QUOTA_KEY, quotaOpts); // 5th of the new episode
		expect(slackCalls()).toHaveLength(1);
	});

	it("does nothing — writes no row — when nothing was tripping (the common case: routine success)", async () => {
		await clearRateLimitTrip(QUOTA_KEY);
		expect(rows.has(QUOTA_KEY)).toBe(false);
	});

	it("never posts a 'recovered' announcement — this is silent decay, not a status change worth telling anyone", async () => {
		for (let i = 0; i < 5; i++) await recordRateLimitTrip(QUOTA_KEY, quotaOpts);
		fetchMock.mockClear();
		await clearRateLimitTrip(QUOTA_KEY);
		expect(slackCalls()).toHaveLength(0);
	});

	it("is best-effort: an unreachable alert-state DB never throws", async () => {
		const boom = vi.spyOn(rows, "values").mockImplementation(() => {
			throw new Error("pooler down");
		});
		await expect(clearRateLimitTrip(QUOTA_KEY)).resolves.toBeUndefined();
		boom.mockRestore();
	});
});

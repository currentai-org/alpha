import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB seam + config so we can drive the fail-open / over-limit branches deterministically.
// vi.hoisted lets the mock factories (hoisted above imports) share these handles with the tests.
const { insertOne, insertMany, countDocuments, find, mockUsageLimits, mockConfig, hashIp, recordRateLimitTrip } =
	vi.hoisted(() => ({
		insertOne: vi.fn(),
		find: vi.fn(),
		insertMany: vi.fn(),
		countDocuments: vi.fn(),
		mockUsageLimits: { messagesPerMinute: 5 } as { messagesPerMinute?: number },
		mockConfig: { GLOBAL_DAILY_REQUEST_CAP: "0", RATE_LIMIT_IP_MULTIPLIER: "0" } as Record<
			string,
			string
		>,
		hashIp: vi.fn(() => "iphash"),
		recordRateLimitTrip: vi.fn(
			(_key: string, _opts: { limitName: string; identity: string }) => Promise.resolve()
		),
	}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { messageEvents: { insertOne, insertMany, countDocuments, find } },
}));
vi.mock("$lib/chat/server/usageLimits", () => ({ usageLimits: mockUsageLimits }));
vi.mock("$lib/chat/server/config", () => ({ config: mockConfig }));
vi.mock("$lib/chat/server/db/ipHash", () => ({ hashIp }));
vi.mock("$lib/chat/stores/errors", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/stores/errors")>()),
	ERROR_MESSAGES: { rateLimited: "rate limited" },
}));
vi.mock("$lib/chat/server/logger.js", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
// enforceRequestRateLimits must ALERT on a trip, not just 429 it — mocked here (not the real
// DB-backed module) so these tests assert the call site, matching alerting.spec.ts's own thorough
// coverage of recordRateLimitTrip's actual fire/debounce logic rather than duplicating it. (CUR-1134)
vi.mock("$lib/chat/server/alerting", () => ({ recordRateLimitTrip }));

import { chargeScreeningCost, enforceRequestRateLimits } from "./rateLimit";
import { isRateLimitMessage } from "$lib/chat/stores/errors";

const OPTS = { userId: "session-1", clientAddress: "203.0.113.7" };

beforeEach(() => {
	insertOne.mockReset().mockResolvedValue(undefined);
	insertMany.mockReset().mockResolvedValue(undefined);
	countDocuments.mockReset().mockResolvedValue(0);
	find.mockReset(); // no rows to read, so a wait read fails as it does on a DB error
	hashIp.mockReset().mockReturnValue("iphash");
	recordRateLimitTrip.mockReset().mockResolvedValue(undefined);
	mockUsageLimits.messagesPerMinute = 5;
	mockConfig.GLOBAL_DAILY_REQUEST_CAP = "0";
	mockConfig.RATE_LIMIT_IP_MULTIPLIER = "0";
});

describe("enforceRequestRateLimits", () => {
	it("records the turn and resolves when under the per-session limit", async () => {
		countDocuments.mockResolvedValue(1); // 1 ≤ 5
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
		expect(insertOne).toHaveBeenCalledTimes(1); // the per-message event
		expect(recordRateLimitTrip).not.toHaveBeenCalled(); // no trip, nothing to alert on
	});

	// A 429 with no alert is the exact gap this ticket closes — pin the call site directly,
	// not just that recordRateLimitTrip itself works (alerting.spec.ts already covers that in full). (CUR-1134)
	it("throws 429 AND records the trip when the per-session count exceeds the limit", async () => {
		countDocuments.mockResolvedValue(6); // 6 > 5
		await expect(enforceRequestRateLimits(OPTS)).rejects.toMatchObject({ status: 429 });
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toContain("session");
	});

	// The session_rate_limit_low fault's override replaces both the limit and the window. (CUR-2804)
	it("with a per-session override, refuses past its limit and records events for its window, not a minute", async () => {
		countDocuments.mockResolvedValue(2); // 2 > 1, though 2 ≤ messagesPerMinute's 5
		const before = Date.now();
		await expect(
			enforceRequestRateLimits({ ...OPTS, perSession: { limit: 1, windowMs: 5_000 } })
		).rejects.toMatchObject({ status: 429 });
		const { createdAt, expiresAt } = insertOne.mock.calls[0][0] as { createdAt: Date; expiresAt: Date };
		expect(createdAt.getTime()).toBeGreaterThanOrEqual(before);
		expect(expiresAt.getTime() - createdAt.getTime()).toBeLessThan(6_000);
	});

	it("with a per-session override, counts only after this send's own row has landed, so a limit of one refuses the second send every time (CUR-2804)", async () => {
		let stored = 1; // the first send's row
		let land: () => void = () => {};
		insertOne.mockImplementation(
			() => new Promise<void>((resolve) => (land = () => ((stored += 1), resolve())))
		);
		countDocuments.mockImplementation(async () => stored);
		const pending = enforceRequestRateLimits({ ...OPTS, perSession: { limit: 1, windowMs: 30_000 } });
		await new Promise((r) => setTimeout(r, 10));
		expect(countDocuments).not.toHaveBeenCalled(); // still waiting on this send's insert
		land();
		await expect(pending).rejects.toMatchObject({ status: 429 });
	});

	// Under the session_rate_limit_low override (one send per 30 s), a second send is refused with the
	// wait left on the first send's row, so the edit box can count it down. This covers the server-side
	// refusal without a real model turn (SOL-206).
	it("with a per-session override, the refusal says how much of the window is left (CUR-3410)", async () => {
		countDocuments.mockResolvedValue(2); // the first send's row and this one
		// Both rows must expire before a second send fits under a limit of one. They expire sooner than a
		// whole window, so a wait read from them (18) differs from the unreadable-wait fallback (30).
		const now = Date.now();
		const rows = [{ expiresAt: new Date(now + 12_000) }, { expiresAt: new Date(now + 18_000) }];
		find.mockImplementation(() => ({ toArray: async () => rows }));
		const refusal = (await enforceRequestRateLimits({
			...OPTS,
			perSession: { limit: 1, windowMs: 30_000 },
		}).catch((e) => e)) as { status: number; body: { retryAfterSeconds?: number } };
		expect(refusal.status).toBe(429);
		expect(refusal.body.retryAfterSeconds, "the refusal did not carry the wait left on the session's rows").toBe(18);
	});

	it("without an override, the same count of 2 is under messagesPerMinute and resolves", async () => {
		countDocuments.mockResolvedValue(2);
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
	});

	it("FAILS OPEN when the event insert throws (must not 500 the turn)", async () => {
		insertOne.mockRejectedValue(new Error("db down"));
		countDocuments.mockResolvedValue(0);
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
	});

	it("FAILS OPEN when the per-session count query throws", async () => {
		countDocuments.mockRejectedValue(new Error("db blip"));
		// null count → no throw even though we couldn't verify the limit
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
	});

	it("skips all limits (no count) when messagesPerMinute is unset", async () => {
		mockUsageLimits.messagesPerMinute = undefined;
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
		expect(countDocuments).not.toHaveBeenCalled();
	});

	it("throws 429 AND records the trip when the global daily cap is reached", async () => {
		mockConfig.GLOBAL_DAILY_REQUEST_CAP = "10";
		countDocuments
			.mockResolvedValueOnce(0) // per-session: under limit
			.mockResolvedValueOnce(10); // global daily: at the cap (>= → throw)
		await expect(enforceRequestRateLimits(OPTS)).rejects.toMatchObject({ status: 429 });
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toContain("daily-cap");
	});

	it("enforces an explicitly set per-IP ceiling AND records the trip only when a multiplier and a hash are present", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "2"; // ceiling = 5 * 2 = 10
		countDocuments
			.mockResolvedValueOnce(3) // per-session: under 5
			.mockResolvedValueOnce(11); // per-IP: over 10 → throw
		await expect(enforceRequestRateLimits(OPTS)).rejects.toMatchObject({ status: 429 });
		expect(recordRateLimitTrip).toHaveBeenCalledTimes(1);
		expect(recordRateLimitTrip.mock.calls[0][0]).toContain("ip");
	});

	it("skips the per-IP ceiling when no pepper is configured (hashIp returns null)", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "2";
		hashIp.mockReturnValue(null as unknown as string);
		countDocuments.mockResolvedValue(3); // per-session only; per-IP must be skipped
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
		expect(countDocuments).toHaveBeenCalledTimes(1); // per-session only, no per-IP count
	});

	// The ceiling is on unless someone turns it off, and sized for a room behind one NAT. (CUR-3191)
	it("enforces the per-IP ceiling by default, at 25 × the per-session rate, when no multiplier is set", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "";
		countDocuments
			.mockResolvedValueOnce(1) // per-session: under 5
			.mockResolvedValueOnce(126); // per-IP: over 5 * 25 = 125 → throw
		await expect(enforceRequestRateLimits(OPTS)).rejects.toMatchObject({ status: 429 });
	});

	it("lets a room of visitors through the default per-IP ceiling right up to it", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "";
		countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(125); // exactly at the ceiling
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
	});

	it("turns the per-IP ceiling off when the multiplier is explicitly 0", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "0";
		countDocuments.mockResolvedValue(1);
		await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
		expect(countDocuments).toHaveBeenCalledTimes(1); // per-session only
	});

	it("words the per-IP refusal for a shared network, and the composer holds it like any rate limit", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "";
		countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(126);
		const refusal = await enforceRequestRateLimits(OPTS).catch((e: { body: { message: string } }) => e);
		const message = (refusal as { body: { message: string } }).body.message;
		expect(message).toMatch(/your network/);
		expect(isRateLimitMessage(message)).toBe(true);
	});

	// The client holds Send only for a refusal that says how long. These mocks have no `find`,
	// so the wait read fails, and the refusal must still carry a wait. (CUR-3410)
	it("still says how long when the per-session wait can't be read: the whole window (CUR-3410)", async () => {
		countDocuments.mockResolvedValue(6);
		const refusal = (await enforceRequestRateLimits(OPTS).catch((e) => e)) as {
			body: { retryAfterSeconds?: number };
		};
		expect(refusal.body.retryAfterSeconds).toBe(60);
	});

	it("says how long on the per-IP ceiling's refusal too, so a room at an event sees Send held (CUR-3410)", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "";
		countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(126);
		const refusal = (await enforceRequestRateLimits(OPTS).catch((e) => e)) as {
			status: number;
			body: { message: string; retryAfterSeconds?: number };
		};
		expect(refusal.status).toBe(429);
		expect(refusal.body.message).toMatch(/your network/);
		expect(refusal.body.retryAfterSeconds).toBe(60);
	});

	it("reads the per-IP wait from the network's own rows against the ceiling, not the session's (CUR-3410)", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "2"; // ceiling = 5 * 2 = 10
		countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(11);
		const now = Date.now();
		// 11 live rows; the 11th send fits once 2 have expired, the second at +8 s.
		const rows = [3, 8, 20, 25, 30, 35, 40, 45, 50, 55, 59].map((s) => ({ expiresAt: new Date(now + s * 1000) }));
		find.mockImplementation((filter: { ipHash?: string }) => ({
			toArray: async () => (filter.ipHash === "iphash" ? rows : []),
		}));
		const refusal = (await enforceRequestRateLimits(OPTS).catch((e) => e)) as {
			body: { retryAfterSeconds?: number };
		};
		expect(refusal.body.retryAfterSeconds).toBe(8);
	});

	it("FAILS CLOSED with a 503 that says why when the global daily cap cannot be counted", async () => {
		mockConfig.GLOBAL_DAILY_REQUEST_CAP = "10";
		countDocuments
			.mockResolvedValueOnce(0) // per-session: under limit
			.mockRejectedValueOnce(new Error("db down")); // daily count fails
		const refusal = await enforceRequestRateLimits(OPTS).catch((e: unknown) => e);
		expect(refusal).toMatchObject({ status: 503 });
		const message = (refusal as { body: { message: string } }).body.message;
		expect(message).toMatch(/couldn't check today's request limit/);
		expect(isRateLimitMessage(message)).toBe(true);
	});
});

// Conversation creates had no limit at all. They count under their own event type, so a
// create never spends the turn it precedes, and stay out of the daily cap, which counts model calls. (CUR-3529)
describe("enforceRequestRateLimits for conversation creates", () => {
	const CREATE = { ...OPTS, event: "conversationCreate" as const };

	it("refuses a create past the per-session rate, counting creates only and never turns", async () => {
		countDocuments.mockResolvedValue(6); // 6 > 5
		await expect(enforceRequestRateLimits(CREATE)).rejects.toMatchObject({ status: 429 });
		expect(insertOne.mock.calls[0][0]).toMatchObject({ type: "conversationCreate" });
		expect(countDocuments.mock.calls[0][0]).toMatchObject({ type: "conversationCreate" });
	});

	it("refuses a create past the per-IP ceiling, counting creates from that address", async () => {
		mockConfig.RATE_LIMIT_IP_MULTIPLIER = "2";
		countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(11); // session fine, IP 11 > 5×2
		await expect(enforceRequestRateLimits(CREATE)).rejects.toMatchObject({ status: 429 });
		expect(countDocuments.mock.calls[1][0]).toMatchObject({ type: "conversationCreate", ipHash: "iphash" });
	});

	it("leaves the daily cap alone: a create neither checks it nor adds to it", async () => {
		mockConfig.GLOBAL_DAILY_REQUEST_CAP = "10";
		countDocuments.mockResolvedValue(0);
		await expect(enforceRequestRateLimits(CREATE)).resolves.toBeUndefined();
		const types = [...countDocuments.mock.calls, ...insertOne.mock.calls].map(
			(c) => (c[0] as { type: string }).type
		);
		expect(types).not.toContain("globalDaily");
	});
});

// A turn's guard screen re-reads the conversation's whole history, up to 9 chunks of 13
// judge calls each. The turn is charged a row per chunk past its first against the same shared
// per-minute rows, so the cost is bounded whichever server instance answers. (CUR-3532)
describe("chargeScreeningCost", () => {
	type Row = { type: string; userId?: string; ipHash?: string };
	let rows: Row[];
	beforeEach(() => {
		rows = [];
		insertOne.mockImplementation(async (doc: Row) => void rows.push(doc));
		insertMany.mockImplementation(async (docs: Row[]) => void rows.push(...docs));
		countDocuments.mockImplementation(
			async (f: Row) =>
				rows.filter(
					(r) =>
						r.type === f.type &&
						(f.userId === undefined || r.userId === f.userId) &&
						(f.ipHash === undefined || r.ipHash === f.ipHash)
				).length
		);
		mockUsageLimits.messagesPerMinute = 20;
	});

	it("refuses the fourth turn in a minute when each turn screened 9 chunks of history", async () => {
		for (let turn = 1; turn <= 3; turn++) {
			await expect(enforceRequestRateLimits(OPTS)).resolves.toBeUndefined();
			await chargeScreeningCost({ ...OPTS, guardChunks: 9 });
		}
		await expect(enforceRequestRateLimits(OPTS)).rejects.toMatchObject({ status: 429 });
	});

	it("charges nothing extra for a turn that fits one chunk", async () => {
		await enforceRequestRateLimits(OPTS);
		await chargeScreeningCost({ ...OPTS, guardChunks: 1 });
		await chargeScreeningCost({ ...OPTS, guardChunks: 0 });
		expect(rows).toHaveLength(1);
	});

	it("charges the extra chunks to the network as well, so a fresh session per send is still bounded", async () => {
		await chargeScreeningCost({ ...OPTS, guardChunks: 9 });
		expect(rows).toHaveLength(8);
		expect(rows.every((r) => r.type === "message" && r.userId === OPTS.userId && r.ipHash === "iphash")).toBe(true);
	});
});

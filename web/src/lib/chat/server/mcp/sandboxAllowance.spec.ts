// Usage tiers for the conversation's sandbox. The contracts: a new account runs code from its
// first message with one live sandbox and a small daily allowance; a call past either limit is refused
// before it reaches agent-service, with when it frees up and how the tier grows; clean use over days
// moves the account up; a real safety decline holds it on the first tier; a database failure never
// refuses a call on its own. (CUR-4578)
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/chat/server/db/sandboxRuns", () => ({ dbSandboxRunStore: {} }));

import { decide, decidePool, staffStanding, tierFor, withSandboxAllowance } from "./sandboxAllowance";
import { isTestAccountEmail } from "$lib/chat/server/teamAccount";
import { retryAfterWords } from "$lib/chat/server/retryAfterWords";
import { parseSandboxTiers, SANDBOX_TIERS } from "../../../../../config/sandboxTiers";
import type { RecentRun, RunHistory, SandboxRunStore } from "$lib/chat/server/db/sandboxRuns";
import type { McpServersKit } from "./serversKit";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const [NEW, REGULAR, ESTABLISHED] = SANDBOX_TIERS.tiers;
const fresh: RunHistory = { runs: 0, firstRunAt: null, declined: false };
const run = (agoMs: number, conversationId = "conv-a"): RecentRun => ({ createdAt: new Date(NOW - agoMs), conversationId });

describe("the tier table (config/sandboxTiers.ts)", () => {
	it("parses, starts every account at 0 runs and 0 days, and never gives more live sandboxes than agent-service allows", () => {
		expect(NEW).toMatchObject({ runsToReach: 0, daysToReach: 0, maxLive: 1 });
		expect(Math.max(...SANDBOX_TIERS.tiers.map((t) => t.maxLive))).toBeLessThanOrEqual(2);
	});

	it("refuses a table whose next tier gives less, or whose first tier is not free to reach", () => {
		const base = { liveIdleMinutes: 10, historyDays: 30, declineHoldDays: 30, testAccountsMaxLive: 2 };
		expect(() => parseSandboxTiers({ ...base, tiers: [{ ...NEW, runsToReach: 5 }] })).toThrow();
		expect(() => parseSandboxTiers({ ...base, tiers: [NEW, { ...REGULAR, runsPerDay: NEW.runsPerDay }] })).toThrow();
		expect(() => parseSandboxTiers({ ...base, tiers: [NEW, { ...REGULAR, maxLive: 3 }] })).toThrow();
	});
});

describe("tierFor", () => {
	it("puts a new account on the first tier", () => {
		expect(tierFor(fresh, NOW).tier).toBe(NEW);
	});

	it("moves an account up only once it has both the runs and the days", () => {
		const runsOnly = { runs: REGULAR.runsToReach, firstRunAt: new Date(NOW - HOUR), declined: false };
		expect(tierFor(runsOnly, NOW).tier).toBe(NEW);
		const both = { ...runsOnly, firstRunAt: new Date(NOW - REGULAR.daysToReach * DAY) };
		expect(tierFor(both, NOW).tier).toBe(REGULAR);
		const lots = { runs: ESTABLISHED.runsToReach, firstRunAt: new Date(NOW - ESTABLISHED.daysToReach * DAY), declined: false };
		expect(tierFor(lots, NOW)).toMatchObject({ tier: ESTABLISHED, next: undefined });
	});

	it("holds an account with a recent safety decline on the first tier, whatever its history", () => {
		const lots = { runs: 1_000, firstRunAt: new Date(NOW - 20 * DAY), declined: true };
		expect(tierFor(lots, NOW)).toMatchObject({ tier: NEW, held: true });
	});
});

// The live-window cases below are worked in minutes on a ten-minute window, so they read the same whatever the
// configured window is; the case after them checks the configured one.
const TEN_MINUTE_WINDOW = { ...SANDBOX_TIERS, liveIdleMinutes: 10 };

describe("decide", () => {
	const newAccount = tierFor(fresh, NOW);

	it("a new account gets one live sandbox, and a second conversation is refused with the reset time", () => {
		const recent = [run(3 * MIN, "conv-a")];
		expect(decide({ standing: newAccount, recent, conversationId: "conv-a", now: NOW, cfg: TEN_MINUTE_WINDOW })).toEqual({ ok: true });
		const second = decide({ standing: newAccount, recent, conversationId: "conv-b", now: NOW, cfg: TEN_MINUTE_WINDOW });
		expect(second).toMatchObject({ ok: false, limit: "live", retryAfterSecs: 7 * 60 });
		expect(second.ok === false && second.text).toContain("frees up in 7 minutes");
		expect(second.ok === false && second.text).toContain(`moves up to 2 sandboxes at a time and ${REGULAR.runsPerDay} runs a day`);
	});

	it("frees a new account's one live sandbox within the configured window, which matches agent-service's 120 s run-code pause", () => {
		// A visitor who opens a second conversation waits at most this long; it is two minutes, not ten.
		expect(SANDBOX_TIERS.liveIdleMinutes).toBe(2);
		const second = decide({ standing: newAccount, recent: [run(0, "conv-a")], conversationId: "conv-b", now: NOW });
		expect(second).toMatchObject({ ok: false, limit: "live", retryAfterSecs: 2 * 60 });
		expect(second.ok === false && second.text).toContain("frees up in 2 minutes");
	});

	it("a conversation idle past the window no longer counts as live, so a new one may start", () => {
		const recent = [run(SANDBOX_TIERS.liveIdleMinutes * MIN + 1, "conv-a")];
		expect(decide({ standing: newAccount, recent, conversationId: "conv-b", now: NOW })).toEqual({ ok: true });
	});

	it("a regular account gets two live sandboxes, and the third is refused", () => {
		const regular = tierFor({ runs: REGULAR.runsToReach, firstRunAt: new Date(NOW - 3 * DAY), declined: false }, NOW);
		const recent = [run(2 * MIN, "conv-a"), run(MIN, "conv-b")];
		expect(decide({ standing: regular, recent: recent.slice(0, 1), conversationId: "conv-b", now: NOW, cfg: TEN_MINUTE_WINDOW }).ok).toBe(true);
		expect(decide({ standing: regular, recent, conversationId: "conv-c", now: NOW, cfg: TEN_MINUTE_WINDOW })).toMatchObject({ ok: false, limit: "live" });
	});

	it("the call past the daily allowance is refused, with when the oldest counted run stops counting", () => {
		// Oldest run 21 hours ago, so room opens in 3 hours.
		const recent = Array.from({ length: NEW.runsPerDay }, (_, i) => run(21 * HOUR - i * MIN));
		const verdict = decide({ standing: newAccount, recent, conversationId: "conv-a", now: NOW });
		expect(verdict).toMatchObject({ ok: false, limit: "daily", retryAfterSecs: 3 * 3600 });
		expect(verdict.ok === false && verdict.text).toContain(`used today's ${NEW.runsPerDay} code runs`);
		expect(verdict.ok === false && verdict.text).toContain("opens up in about 3 hours");
		expect(decide({ standing: newAccount, recent: recent.slice(1), conversationId: "conv-a", now: NOW }).ok).toBe(true);
	});

	it("tells a held account why it is not growing", () => {
		const held = tierFor({ ...fresh, declined: true }, NOW);
		const v = decide({ standing: held, recent: [run(MIN, "conv-a")], conversationId: "conv-b", now: NOW });
		expect(v.ok === false && v.text).toContain("declined by the safety screen");
	});
});

describe("retryAfterWords", () => {
	it("says minutes under an hour and hours above", () => {
		expect(retryAfterWords(30)).toBe("in 1 minute");
		expect(retryAfterWords(7 * 60)).toBe("in 7 minutes");
		expect(retryAfterWords(3 * 3600)).toBe("in about 3 hours");
	});
});

describe("the shared test-account pool", () => {
	it("knows an e2e suite's disposable account and no one else's", () => {
		expect(isTestAccountEmail("e2e-r123-0f1e@example.org")).toBe(true);
		expect(isTestAccountEmail("e2e-0f1e@currentai.org")).toBe(true);
		expect(isTestAccountEmail("editor@currentai.org")).toBe(false);
		expect(isTestAccountEmail("someone@example.org")).toBe(false);
		expect(isTestAccountEmail(undefined)).toBe(false);
	});

	it("lets all test accounts together hold testAccountsMaxLive sandboxes, and refuses the next with when one frees up", () => {
		const pool = [run(4 * MIN, "conv-x"), run(2 * MIN, "conv-y")];
		expect(decidePool({ recent: pool.slice(0, 1), conversationId: "conv-z", now: NOW, cfg: TEN_MINUTE_WINDOW }).ok).toBe(true);
		expect(decidePool({ recent: pool, conversationId: "conv-x", now: NOW, cfg: TEN_MINUTE_WINDOW }).ok).toBe(true);
		const third = decidePool({ recent: pool, conversationId: "conv-z", now: NOW, cfg: TEN_MINUTE_WINDOW });
		expect(third).toMatchObject({ ok: false, limit: "live", retryAfterSecs: 6 * 60 });
		expect(third.ok === false && third.text).toContain("Test accounts share 2 code sandboxes");
	});
});

/** The sandbox kit stand-in: every call it gets answers ok. */
function fakeKit() {
	const ran: string[] = [];
	const kit = {
		label: "mcp-servers",
		definitions: [],
		blocked: [],
		async *beforeRun() {},
		run: async (c: { name: string }) => {
			ran.push(c.name);
			return { content: "exit code 0", mcpCall: { server: "sandbox", tool: c.name.split("__")[1], outcome: "ok", ms: 5 } };
		},
	} as unknown as McpServersKit;
	return { kit, ran };
}

function memoryStore(rows: RecentRun[] = [], history: RunHistory = fresh): SandboxRunStore & { rows: RecentRun[] } {
	return {
		rows,
		history: vi.fn(async () => history),
		recent: async () => rows,
		record: async (_u, conversationId) => {
			rows.push({ createdAt: new Date(NOW), conversationId });
		},
	};
}

const call = (tool: string, id = "c1") => ({ id, name: `sandbox__${tool}`, arguments: "{}" });

describe("withSandboxAllowance", () => {
	it("a team account starts on the highest tier, even when new and held by a decline, so a second conversation's run goes through (CUR-4620)", async () => {
		const declined: RunHistory = { runs: 0, firstRunAt: null, declined: true };
		const store = memoryStore([run(MIN, "conv-a")], declined);
		const staff = fakeKit();
		const gated = withSandboxAllowance(staff.kit, { userId: "u1", conversationId: "conv-b", serverName: "sandbox", store, now: () => NOW, staff: true });
		expect((await gated.run(call("run_code"))).mcpCall?.outcome).toBe("ok");
		expect(staff.ran).toEqual(["sandbox__run_code"]);
		expect(store.history).not.toHaveBeenCalled();
		expect(staffStanding()).toMatchObject({ tier: ESTABLISHED, held: false });

		const visitorStore = memoryStore([run(MIN, "conv-a")], declined);
		const visitor = fakeKit();
		const gatedVisitor = withSandboxAllowance(visitor.kit, { userId: "u2", conversationId: "conv-b", serverName: "sandbox", store: visitorStore, now: () => NOW });
		expect((await gatedVisitor.run(call("run_code"))).mcpCall?.outcome).toBe("allowance");
		expect(visitor.ran).toEqual([]);
	});

	it("a team account is still stopped at the highest tier's daily runs, so a runaway loop ends (CUR-4620)", async () => {
		const today = Array.from({ length: ESTABLISHED.runsPerDay }, (_, i) => run(HOUR + i * 1000, "conv-a"));
		const store = memoryStore(today);
		const { kit, ran } = fakeKit();
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store, now: () => NOW, staff: true });
		const refused = await gated.run(call("run_code"));
		expect(refused.mcpCall).toMatchObject({ outcome: "allowance" });
		expect(refused.mcpCall?.output).toContain(`today's ${ESTABLISHED.runsPerDay} code runs`);
		expect(ran).toEqual([]);
	});

	it("a new account's first run goes through and is recorded; a second conversation's run is refused before it reaches the sandbox", async () => {
		const store = memoryStore();
		const a = fakeKit();
		const gatedA = withSandboxAllowance(a.kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store, now: () => NOW });
		expect((await gatedA.run(call("run_code"))).mcpCall?.outcome).toBe("ok");
		expect(store.rows).toHaveLength(1);

		const b = fakeKit();
		const gatedB = withSandboxAllowance(b.kit, { userId: "u1", conversationId: "conv-b", serverName: "sandbox", store, now: () => NOW });
		const refused = await gatedB.run(call("run_code"));
		expect(b.ran).toEqual([]);
		expect(refused.mcpCall).toMatchObject({ server: "sandbox", tool: "run_code", outcome: "allowance" });
		expect(refused.mcpCall?.output).toContain(`frees up in ${SANDBOX_TIERS.liveIdleMinutes} minutes`);
		expect(refused.content).toMatch(/^not run: /);
	});

	it("never counts or refuses a read, which starts no sandbox", async () => {
		const store = memoryStore([run(MIN, "conv-a")]);
		const { kit, ran } = fakeKit();
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-b", serverName: "sandbox", store, now: () => NOW });
		expect((await gated.run(call("list_files"))).mcpCall?.outcome).toBe("ok");
		expect(ran).toEqual(["sandbox__list_files"]);
		expect(store.rows).toHaveLength(1);
	});

	it("reads the account's history once per turn, not once per call", async () => {
		const store = memoryStore();
		const { kit } = fakeKit();
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store, now: () => NOW });
		await gated.run(call("run_code", "c1"));
		await gated.run(call("run_command", "c2"));
		expect(store.history).toHaveBeenCalledTimes(1);
	});

	it("a sandbox that cannot start or resume gives the person a plain message, and the attempt does not count against the allowance", async () => {
		const store = memoryStore();
		const kit = {
			...fakeKit().kit,
			run: async () => ({
				content: "The tool reported an error",
				mcpCall: { server: "sandbox", tool: "run_code", outcome: "tool_error", ms: 9, output: "Error executing tool run_code: SandboxException: failed to resume" },
			}),
		} as unknown as McpServersKit;
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store, now: () => NOW });
		const res = await gated.run(call("run_code"));
		expect(res.mcpCall?.output).toContain("could not start or wake up just now");
		expect(res.mcpCall?.output).not.toContain("SandboxException");
		expect(res.content).toMatch(/^not run: /);
		expect(store.rows).toHaveLength(0);
	});

	it("passes a refusal about the person's own input through unchanged", async () => {
		const kit = {
			...fakeKit().kit,
			run: async () => ({
				content: "x",
				mcpCall: { server: "sandbox", tool: "write_file", outcome: "tool_error", ms: 2, output: "'../etc' is outside the workspace" },
			}),
		} as unknown as McpServersKit;
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store: memoryStore(), now: () => NOW });
		expect((await gated.run(call("write_file"))).mcpCall?.output).toBe("'../etc' is outside the workspace");
	});

	it("a test account's run is refused when other test accounts hold the pool, though its own tier has room, and a run that goes through is counted in both", async () => {
		const store = memoryStore();
		const poolRows: RecentRun[] = [run(MIN, "ci-1"), run(MIN, "ci-2")];
		const recorded: string[] = [];
		const pooled: SandboxRunStore = {
			history: store.history,
			recent: async (key) => (key.startsWith("sandbox-pool:") ? poolRows : store.rows),
			record: async (key, conversationId) => {
				recorded.push(key);
				(key.startsWith("sandbox-pool:") ? poolRows : store.rows).push({ createdAt: new Date(NOW), conversationId });
			},
		};
		const a = fakeKit();
		const refused = await withSandboxAllowance(a.kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", testPool: true, store: pooled, now: () => NOW }).run(call("run_code"));
		expect(a.ran).toEqual([]);
		expect(refused.mcpCall?.output).toContain("Test accounts share");

		poolRows.splice(0, 1);
		const b = fakeKit();
		const ran = await withSandboxAllowance(b.kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", testPool: true, store: pooled, now: () => NOW }).run(call("run_code"));
		expect(ran.mcpCall?.outcome).toBe("ok");
		expect(recorded).toEqual(["u1", "sandbox-pool:e2e-accounts"]);
	});

	it("an account outside the test pool never reads or writes it", async () => {
		const keys: string[] = [];
		const store = memoryStore();
		const watched: SandboxRunStore = {
			history: store.history,
			recent: async (key, since) => (keys.push(key), store.recent(key, since)),
			record: async (key, c, k) => (keys.push(key), store.record(key, c, k)),
		};
		await withSandboxAllowance(fakeKit().kit, { userId: "u1", conversationId: "conv-a", serverName: "sandbox", store: watched, now: () => NOW }).run(call("run_code"));
		expect(keys).toEqual(["u1", "u1"]);
	});

	it("fails open: a failed read of recent runs lets the call through, and a failed history read means the first tier, not a refusal", async () => {
		const { kit, ran } = fakeKit();
		const broken: SandboxRunStore = {
			history: async () => {
				throw new Error("db down");
			},
			recent: async () => {
				throw new Error("db down");
			},
			record: async () => {
				throw new Error("db down");
			},
		};
		const gated = withSandboxAllowance(kit, { userId: "u1", conversationId: "conv-b", serverName: "sandbox", store: broken, now: () => NOW });
		expect((await gated.run(call("run_code"))).mcpCall?.outcome).toBe("ok");
		expect(ran).toEqual(["sandbox__run_code"]);
	});
});

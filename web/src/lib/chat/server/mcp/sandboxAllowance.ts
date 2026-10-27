// Usage tiers for the conversation's sandbox (CUR-4578). Every signed-in account can run code from its
// first message; the tier decides how much. Two limits, both read from `config/sandboxTiers.ts`:
//
//   live    conversations holding a running sandbox at once. A sandbox pauses after the idle window
//           with no call, so a conversation with a call inside that window counts as live.
//   daily   sandbox calls (run_code, run_command, write_file) in any 24 hours.
//
// A call past either is refused here, before it reaches agent-service, with a plain message saying when
// it frees up and how the allowance grows. The model is told to pass that on, and step by step shows
// the same text. Reads (read_file, list_files) never start a sandbox, so they are never counted or
// refused.
//
// The tier comes from the account's own history (db/sandboxRuns.ts): runs still inside the history
// window and the days since the first of them. A real safety decline on the account holds it on the
// first tier. History is per account, never pooled across the service token's callers.
//
// FAILS OPEN on a database error, like the agent-task and attachment allowances: a failed history read
// leaves the account on the first tier, and a failed read of recent runs lets the call through.
// agent-service still refuses a third live sandbox for any account (`E2B_ACCOUNT_MAX_LIVE`).
//
// A team account (teamAccount.ts, CUR-4620) starts on the highest tier and is never held on the first:
// staff test the safety screen on purpose, so a decline on their account says nothing about abuse.
// The highest tier is still a daily cap, and agent-service's live ceiling applies as to anyone.
//
// The e2e suites' disposable test accounts (`e2e-…@example.org`, `e2e-…@currentai.org`) also share one
// pool of live sandboxes, `testAccountsMaxLive` across all of them, so a burst of CI runs cannot take
// every slot on a small host from the staff using it. A run on the in-process `sandbox_stub` touches
// no host, so turnKit.ts leaves it out of the pool.
import { logger } from "$lib/chat/server/logger";
import type { NativeToolResult, StreamedToolCall } from "$lib/chat/server/endpoints/types";
import { dbSandboxRunStore, type RecentRun, type RunHistory, type SandboxRunStore } from "$lib/chat/server/db/sandboxRuns";
import { SANDBOX_TIERS, type SandboxTier, type SandboxTierConfig } from "../../../../../config/sandboxTiers";
import { retryAfterWords } from "$lib/chat/server/retryAfterWords";
import type { McpServersKit } from "./serversKit";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
/** Calls that start the conversation's sandbox when it has none. */
const COUNTED_TOOLS = new Set(["run_code", "run_command", "write_file"]);
/** The key the shared test-account pool's rows are written under, in place of an account id. */
const TEST_POOL_KEY = "sandbox-pool:e2e-accounts";

type TierStanding = { tier: SandboxTier; index: number; next?: SandboxTier; held: boolean };

/** A team account's standing: the highest tier, whatever its history (CUR-4620).
 *  @internal exported for sandboxAllowance.spec */
export function staffStanding(cfg: SandboxTierConfig = SANDBOX_TIERS): TierStanding {
	const index = cfg.tiers.length - 1;
	return { tier: cfg.tiers[index], index, held: false };
}

/** The highest tier the history reaches, or the first while a recent decline holds the account.
 *  @internal exported for sandboxAllowance.spec */
export function tierFor(history: RunHistory, now: number, cfg: SandboxTierConfig = SANDBOX_TIERS): TierStanding {
	const days = history.firstRunAt ? (now - history.firstRunAt.getTime()) / DAY_MS : 0;
	let index = 0;
	if (!history.declined) {
		cfg.tiers.forEach((t, i) => {
			if (history.runs >= t.runsToReach && days >= t.daysToReach) index = i;
		});
	}
	return { tier: cfg.tiers[index], index, next: cfg.tiers[index + 1], held: history.declined };
}

type AllowanceVerdict =
	| { ok: true }
	| { ok: false; limit: "live" | "daily"; retryAfterSecs: number; text: string };

/** Whether one more counted call fits, given the account's runs from the last 24 hours (oldest first).
 *  Pure: everything it needs is passed in.
 *  @internal exported for sandboxAllowance.spec */
export function decide(input: {
	standing: TierStanding;
	recent: RecentRun[];
	conversationId: string;
	now: number;
	cfg?: SandboxTierConfig;
}): AllowanceVerdict {
	const { standing, recent, conversationId, now } = input;
	const cfg = input.cfg ?? SANDBOX_TIERS;
	const { tier } = standing;
	const idleMs = cfg.liveIdleMinutes * MINUTE_MS;

	const live = liveRoom(recent, conversationId, tier.maxLive, now, idleMs);
	if (live) {
		return { ok: false, limit: "live", retryAfterSecs: live.retryAfterSecs, text: liveText(standing, live.others, live.retryAfterSecs, cfg) };
	}

	// Daily: calls in the last 24 hours.
	const today = recent.map((r) => r.createdAt.getTime()).filter((t) => now - t < DAY_MS);
	if (today.length >= tier.runsPerDay) {
		const at = today[today.length - tier.runsPerDay] + DAY_MS;
		const retryAfterSecs = Math.max(1, Math.ceil((at - now) / 1000));
		return { ok: false, limit: "daily", retryAfterSecs, text: dailyText(standing, retryAfterSecs, cfg) };
	}
	return { ok: true };
}

/** Whether `conversationId` may hold one more live sandbox among `recent`, where each conversation's
 *  last call inside the idle window counts as live. Null when it fits; otherwise when the sandbox that
 *  must pause for it to fit frees up, and how many other conversations hold one. */
function liveRoom(
	recent: RecentRun[],
	conversationId: string,
	maxLive: number,
	now: number,
	idleMs: number
): { retryAfterSecs: number; others: number } | null {
	const lastCall = new Map<string, number>();
	for (const r of recent) {
		const t = r.createdAt.getTime();
		if (!r.conversationId || now - t >= idleMs) continue;
		lastCall.set(r.conversationId, Math.max(lastCall.get(r.conversationId) ?? 0, t));
	}
	if (lastCall.has(conversationId)) return null;
	const frees = [...lastCall.values()].map((t) => t + idleMs).sort((a, b) => a - b);
	if (frees.length < maxLive) return null;
	const at = frees[frees.length - maxLive];
	return { retryAfterSecs: Math.max(1, Math.ceil((at - now) / 1000)), others: frees.length };
}

/** The test-account pool's verdict: ok when this conversation fits in it, else when one frees up.
 *  @internal exported for sandboxAllowance.spec */
export function decidePool(input: { recent: RecentRun[]; conversationId: string; now: number; cfg?: SandboxTierConfig }): AllowanceVerdict {
	const cfg = input.cfg ?? SANDBOX_TIERS;
	const room = liveRoom(input.recent, input.conversationId, cfg.testAccountsMaxLive, input.now, cfg.liveIdleMinutes * MINUTE_MS);
	if (!room) return { ok: true };
	const text = `Test accounts share ${plural(cfg.testAccountsMaxLive, "code sandbox")} on this deployment, so test runs never take every sandbox from people, and all of them are in use. One frees up ${retryAfterWords(room.retryAfterSecs)}.`;
	return { ok: false, limit: "live", retryAfterSecs: room.retryAfterSecs, text };
}

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : unit.endsWith("x") ? "es" : "s"}`;

function growthText(s: TierStanding, cfg: SandboxTierConfig): string {
	const first = cfg.tiers[0];
	const start = `New accounts start with ${plural(first.maxLive, "sandbox")} at a time and ${first.runsPerDay} runs a day, and the allowance grows with use.`;
	if (s.held) return `${start} It stays at the starting allowance for now, because a recent message on this account was declined by the safety screen.`;
	if (!s.next) return `This account is on the highest allowance: ${plural(s.tier.maxLive, "sandbox")} at a time and ${s.tier.runsPerDay} runs a day.`;
	return `${start} After ${s.next.runsToReach} runs over ${plural(s.next.daysToReach, "day")}, this account moves up to ${plural(s.next.maxLive, "sandbox")} at a time and ${s.next.runsPerDay} runs a day.`;
}

function liveText(s: TierStanding, live: number, secs: number, cfg: SandboxTierConfig): string {
	const others = live === 1 ? "another conversation is using it" : `${live} other conversations are using them`;
	return `This account can have ${plural(s.tier.maxLive, "code sandbox")} running at a time, and ${others}. One frees up ${retryAfterWords(secs)}, once it has gone ${cfg.liveIdleMinutes} minutes without running anything, or you can carry on in that conversation. ${growthText(s, cfg)}`;
}

function dailyText(s: TierStanding, secs: number, cfg: SandboxTierConfig): string {
	return `This account has used today's ${s.tier.runsPerDay} code runs. The next one opens up ${retryAfterWords(secs)}. ${growthText(s, cfg)}`;
}

/** What the person reads when the sandbox could not start or wake: a full host, a paused sandbox that
 *  failed to resume, an unreachable service. Nothing ran, so nothing counts against the allowance. */
const UNAVAILABLE_TEXT =
	"The code sandbox could not start or wake up just now, because the sandbox host is busy or did not answer. Nothing ran, and this does not count against the account's allowance. Try again in a minute; if it keeps happening, start a new conversation.";

// The shapes agent-service and the MCP SDK give a sandbox that did not start or resume: SandboxBusy,
// SandboxError's host and start texts (sandbox_e2b.py), the 503 `sandbox unavailable`, Embed's
// "cannot map" capacity text, and the SDK's bare "Error executing tool" for an exception agent-service
// did not wrap, which is what a failed resume of a paused sandbox gives today (CUR-4565, CUR-4518).
// A refusal about the person's own input (a path outside the workspace) matches none of them.
const UNAVAILABLE_SHAPES =
	/host is full|can't be reached right now|could not be started|sandbox unavailable|cannot map|Error executing tool/i;

/** True when a counted call came back because the sandbox itself was not there to run it. */
function sandboxUnavailable(res: NativeToolResult): boolean {
	const outcome = res.mcpCall?.outcome;
	if (outcome === "failed") return true;
	return outcome === "tool_error" && UNAVAILABLE_SHAPES.test(res.mcpCall?.output ?? res.content);
}

/** The sandbox kit with the account's tier in front of every call that could start a sandbox. One
 *  history read per turn, one recent read per counted call, one write per call that ran. */
export function withSandboxAllowance(
	kit: McpServersKit,
	opts: {
		userId: string;
		conversationId: string;
		serverName: string;
		/** True for an e2e test account, whose live sandboxes also count against the shared test pool. */
		testPool?: boolean;
		/** True for a team account (teamAccount.ts), which gets the highest tier without a history read. */
		staff?: boolean;
		store?: SandboxRunStore;
		now?: () => number;
		cfg?: SandboxTierConfig;
	}
): McpServersKit {
	const store = opts.store ?? dbSandboxRunStore;
	const now = opts.now ?? Date.now;
	const cfg = opts.cfg ?? SANDBOX_TIERS;
	const prefix = `${opts.serverName}__`;
	let standing: Promise<TierStanding> | undefined;

	const readStanding = (): Promise<TierStanding> =>
		(standing ??= opts.staff
			? Promise.resolve(staffStanding(cfg))
			: store
			.history(opts.userId, new Date(now() - cfg.declineHoldDays * DAY_MS))
			.then((h) => tierFor(h, now(), cfg))
			.catch((e) => {
				logger.warn({ leg: "sandbox-allowance", err: e instanceof Error ? e.message : String(e) }, "[sandbox-allowance] history read failed; the account gets the first tier");
				return { tier: cfg.tiers[0], index: 0, next: cfg.tiers[1], held: false };
			}));

	function refuse(tool: string, verdict: Extract<AllowanceVerdict, { ok: false }>, tier: string): NativeToolResult {
		logger.info(
			{ leg: "sandbox-allowance", tool, limit: verdict.limit, tier, retryAfterSecs: verdict.retryAfterSecs },
			"[sandbox-allowance] refused"
		);
		return {
			content: `not run: ${verdict.text} Tell the person this in plain words, including when it frees up and how the allowance grows, and do not call this tool again in this answer.`,
			mcpCall: { server: opts.serverName, tool, outcome: "allowance", ms: 0, output: verdict.text },
		};
	}

	async function run(call: StreamedToolCall): Promise<NativeToolResult> {
		const tool = call.name.startsWith(prefix) ? call.name.slice(prefix.length) : "";
		if (!COUNTED_TOOLS.has(tool)) return kit.run(call);
		const s = await readStanding();
		let recent: RecentRun[] | null = null;
		try {
			recent = await store.recent(opts.userId, new Date(now() - DAY_MS));
		} catch (e) {
			logger.warn({ leg: "sandbox-allowance", err: e instanceof Error ? e.message : String(e) }, "[sandbox-allowance] recent read failed; the call goes through");
		}
		if (recent && opts.testPool) {
			const pool = await store.recent(TEST_POOL_KEY, new Date(now() - cfg.liveIdleMinutes * MINUTE_MS)).catch(() => null);
			const verdict = pool ? decidePool({ recent: pool, conversationId: opts.conversationId, now: now(), cfg }) : { ok: true as const };
			if (!verdict.ok) return refuse(tool, verdict, "test-pool");
		}
		if (recent) {
			const verdict = decide({ standing: s, recent, conversationId: opts.conversationId, now: now(), cfg });
			if (!verdict.ok) return refuse(tool, verdict, s.tier.name);
		}
		const res = await kit.run(call);
		const unavailable = sandboxUnavailable(res);
		if (unavailable) {
			logger.info({ leg: "sandbox-allowance", tool, outcome: res.mcpCall?.outcome }, "[sandbox-allowance] sandbox could not start or resume");
			return {
				content: `not run: ${UNAVAILABLE_TEXT} Tell the person this in plain words, and do not call this tool again in this answer.`,
				mcpCall: { ...res.mcpCall!, output: UNAVAILABLE_TEXT },
			};
		}
		if (res.mcpCall?.outcome === "ok") {
			const writes = [store.record(opts.userId, opts.conversationId, cfg.historyDays * DAY_MS)];
			// The pool reads only its live window, so its rows need not outlive it.
			if (opts.testPool) writes.push(store.record(TEST_POOL_KEY, opts.conversationId, cfg.liveIdleMinutes * MINUTE_MS));
			for (const r of await Promise.allSettled(writes)) {
				if (r.status === "rejected") {
					const e = r.reason;
					logger.warn({ leg: "sandbox-allowance", err: e instanceof Error ? e.message : String(e) }, "[sandbox-allowance] run not recorded");
				}
			}
		}
		return res;
	}

	return { ...kit, run };
}

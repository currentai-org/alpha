/**
 * The daily allowance on agent-mode tasks, per account, counted in chat's own database.
 *
 * agent-service caps each visitor too (AGENT_SUBJECT_DAILY_TASKS), but it counts in each machine's own
 * SQLite, so a pair of machines lets a visitor through twice, and a machine that is replaced forgets
 * the count. Chat already holds a database every deployment shares, so the count lives here and the
 * service's caps stay as the backstop. agent-service holds no database credential for it, which keeps
 * the machines that run visitors' code away from chat's data.
 *
 * One `message_events` row per task agent-service accepted, counted through eventWindow.ts like every
 * other limit there. A guest is refused agent mode before this (CUR-4400); one that got this far is
 * keyed by session id rather than let through uncounted.
 *
 * A team account (teamAccount.ts, CUR-4620) gets STAFF_TIER.agentTasksPerDay instead, and agent-service is
 * told the same number in X-Agent-Subject-Daily-Tasks (agentServiceHeaders), so its per-visitor cap does
 * not stop the account at 25 behind chat's back.
 *
 * FAILS OPEN on a count error, like the attachment allowance: agent-service's own caps still bound the
 * run, so a database blip costs a few extra tasks and nothing more. (CUR-4401)
 */
import { countLiveEvents, recordEvent, secondsUntilRoom, type EventKey } from "$lib/chat/server/db/eventWindow";
import { retryAfterWords } from "$lib/chat/server/retryAfterWords";
import { STAFF_TIER, isTeamAccount } from "$lib/chat/server/teamAccount";

const TYPE = "agentTask";
const LABEL = "agent-task-allowance";

/** Tasks one account may start in any 24 hours. Matches agent-service's per-visitor cap. */
const AGENT_TASKS_PER_DAY = 25;

/** This visitor's daily agent tasks: the staff tier's for a team account, everyone else's otherwise. */
export function agentTasksPerDay(locals: App.Locals | undefined): number {
	return isTeamAccount(locals?.user) ? STAFF_TIER.agentTasksPerDay : AGENT_TASKS_PER_DAY;
}
const AGENT_TASK_WINDOW_MS = 24 * 60 * 60 * 1000;

const keyFor = (locals: App.Locals | undefined): EventKey | null => {
	const owner = locals?.user?._id?.toString() ?? locals?.sessionId;
	return owner ? { type: TYPE, userId: owner } : null;
};

/** `{ ok: true }` while the visitor has a task left today (or the count failed); otherwise the day's
 *  limit and how many seconds until the oldest counted task stops counting, when that could be read. */
export async function agentTaskRoom(
	locals: App.Locals | undefined
): Promise<{ ok: true } | { ok: false; limit: number; retryAfterSecs: number | null }> {
	const key = keyFor(locals);
	if (!key) return { ok: true };
	const limit = agentTasksPerDay(locals);
	const used = await countLiveEvents(key, LABEL);
	if (used === null || used < limit) return { ok: true };
	return { ok: false, limit, retryAfterSecs: await secondsUntilRoom(key, limit, LABEL) };
}

/** Count one task agent-service accepted. Never throws. */
export async function recordAgentTask(locals: App.Locals | undefined): Promise<void> {
	const key = keyFor(locals);
	if (key) await recordEvent(key, AGENT_TASK_WINDOW_MS, LABEL);
}

/** What a visitor sees when today's tasks are used up. */
export function agentTasksUsedText(retryAfterSecs: number | null, limit = AGENT_TASKS_PER_DAY): string {
	const base = `You've used today's ${limit.toLocaleString("en-US")} agent tasks.`;
	if (retryAfterSecs === null) return `${base} More open up within 24 hours.`;
	return `${base} The next one opens up ${retryAfterWords(retryAfterSecs)}.`;
}

/**
 * The daily allowance on chat turns, per account.
 *
 * The service-wide daily cap in chat/rateLimit.ts bounds what the whole deployment spends in a day, and
 * the per-minute limits bound how fast one person sends. Neither stops one account from sending all day
 * and spending the day's room for everyone else. This does, on the same shape as the agent-task
 * allowance (agentTaskAllowance.ts): one `message_events` row per accepted turn, counted
 * through eventWindow.ts over a sliding 24 hours.
 *
 * Keyed on the account id when signed in, else the guest's signed session id (the same `userId` the
 * per-session limit counts). A team account (teamAccount.ts) gets STAFF_TIER.chatTurnsPerDay.
 *
 * FAILS OPEN on a count error: the service-wide daily cap is the fail-closed backstop, so a database
 * blip here costs at most a few turns past one account's share.
 */
import { allowanceRoom, recordEvent, type EventKey } from "$lib/chat/server/db/eventWindow";
import { retryAfterWords } from "$lib/chat/server/retryAfterWords";
import { STAFF_TIER, isTeamAccount } from "$lib/chat/server/teamAccount";
import { CHAT_TURNS_PER_DAY } from "../../../../../config/chatTurns";
import type { MessageEvent } from "$lib/chat/types/MessageEvent";

const TYPE = "chatTurn";
const LABEL = "chat-turn-allowance";
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** This visitor's daily turns: the staff tier's for a team account, everyone else's otherwise. */
export function chatTurnsPerDay(user: App.Locals["user"] | undefined): number {
	return isTeamAccount(user) ? STAFF_TIER.chatTurnsPerDay : CHAT_TURNS_PER_DAY;
}

const keyFor = (owner: MessageEvent["userId"]): EventKey => ({ type: TYPE, userId: owner });

/** `{ ok: true }` while the owner has a turn left today (or the count failed); otherwise how many seconds
 *  until the oldest counted turn stops counting, when that could be read. */
export function chatTurnRoom(
	owner: MessageEvent["userId"],
	limit: number
): Promise<{ ok: true } | { ok: false; retryAfterSecs: number | null }> {
	return allowanceRoom(keyFor(owner), limit, LABEL);
}

/** Count one accepted turn. Never throws. */
export async function recordChatTurn(owner: MessageEvent["userId"]): Promise<void> {
	await recordEvent(keyFor(owner), WINDOW_MS, LABEL);
}

/** What a visitor reads when today's turns are used up. Contains "message limit", which the composer
 *  reads as a limit (isRateLimitMessage) and keeps the unsent text for. */
export function chatTurnsUsedText(limit: number, retryAfterSecs: number | null): string {
	const base = `You've reached today's message limit of ${limit.toLocaleString("en-US")} messages.`;
	if (retryAfterSecs === null) return `${base} More open up within 24 hours.`;
	return `${base} The next one opens up ${retryAfterWords(retryAfterSecs)}.`;
}

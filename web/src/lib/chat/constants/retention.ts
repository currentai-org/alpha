/**
 * Conversation data-retention window for the open alpha.
 *
 * SINGLE SOURCE OF TRUTH for both halves of the promise:
 *   - the user-facing claim — /privacy-notice: "guest conversations are automatically deleted after N days"
 *   - the mechanism that makes it true — the TTL sweep in db/cleanup.ts (run by the daily Vercel cron)
 * so the stated window and the actual deletion can never drift.
 *
 * A plain const (not env-sourced) so the client `/privacy-notice` page can import the same value the server
 * sweeps on.
 */
export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/**
 * Safety-record retention: `safety_events` rows other than child_safety are deleted this many
 * days after they were written, by the same daily sweep in db/cleanup.ts. The privacy notice's "kept no
 * longer than" figure for safety records is this number. child_safety rows are never swept: their period
 * is a legal decision still open.
 */
export const SAFETY_RECORD_RETENTION_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where someone who wants to keep their history goes to run their own Alpha: the public MIT source. */
export const SELF_HOST_URL = "https://github.com/currentai-org/alpha";

/**
 * When a conversation expires under conversation expiry (server/conversationExpiry.ts): any
 * conversation, a guest's, a pinned or a sealed one included. It uses RETENTION_DAYS, so the instance
 * states one number everywhere, counted from the conversation's creation, or from the day expiry was
 * switched on (`launchedAt`) when the conversation is older than that, so one that predates the switch
 * still gets the full window, and the notice, before it goes. A missing `createdAt` counts as the launch day. A null
 * `launchedAt` means expiry has not started on this deployment, so the clock would start `now`.
 *
 * The sweep computes the same thing in SQL (`greatest(created_at, launch) + window`, conversationExpiry.ts);
 * this copy is what the page's "N days left" reads, and conversationExpiry.spec.ts pins the two together.
 */
export function conversationExpiresAt(createdAt: Date | null | undefined, launchedAt: Date | null, now: Date): Date {
	const start = Math.max(createdAt ? new Date(createdAt).getTime() : 0, (launchedAt ?? now).getTime());
	return new Date(start + RETENTION_DAYS * DAY_MS);
}

/** Whole days until `expiresAt`, rounded up and never below 0: the number the badge shows. */
export function daysUntil(expiresAt: Date, now: Date): number {
	return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));
}

/**
 * How many days before its date a conversation starts showing "This chat is deleted on <date>" with
 * Export and Continue in a new chat: from day 23 of the 30.
 */
const EXPIRY_WARNING_DAYS = 7;

/** Whether the delete-date banner shows at `now` for a chat that expires at `expiresAt`. */
export function expiryWarningShows(expiresAt: Date, now: Date): boolean {
	return new Date(expiresAt).getTime() - now.getTime() <= EXPIRY_WARNING_DAYS * DAY_MS;
}

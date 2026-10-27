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
 * Safety-record retention (CUR-4428): `safety_events` rows other than child_safety are deleted this many
 * days after they were written, by the same daily sweep in db/cleanup.ts. The privacy notice's "kept no
 * longer than" figure for safety records is this number. child_safety rows are never swept: their period
 * is a legal decision still open under CUR-2577.
 */
export const SAFETY_RECORD_RETENTION_DAYS = 60;

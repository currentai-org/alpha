/**
 * The record of a member of staff reading a person's conversation content in the app (CUR-4385).
 *
 * Two copies, because they answer different questions. The `admin_audit` row backs /admin/audit and
 * lives in the same Postgres database the admin path can write, so on its own it records an access
 * only for as long as nobody with database write access edits it. The security-logger line goes to the
 * Axiom security dataset (CUR-4143), which nobody with database access can alter, and to stdout, which
 * the Vercel drain also ships to Axiom.
 *
 * Neither write blocks the read: an audit hiccup must not stop triage. The direct-database path is the
 * stricter one; `scripts/prod-db-read.mjs` refuses to run when its audit event cannot be sent.
 *
 * Records who, which conversations, which surface and why. Never the content itself.
 */
import { securityLogger } from "$lib/chat/server/logger";
import { logAdminActionSafe } from "$lib/chat/server/db/adminAudit";
import { hashIp } from "$lib/chat/server/db/ipHash";

/** The in-app surfaces that show staff a person's conversation content. */
type StaffReadSurface = "report.view" | "reports.list";

export interface StaffContentRead {
	/** The signed-in staff member (adminActor). */
	actor: string;
	surface: StaffReadSurface;
	/** Every conversation whose content this read showed. */
	conversationIds: string[];
	/** Why: the report ids that justify it, or the reason the staff member typed. */
	reason: string;
	/** Raw client IP; only its peppered hash is recorded. */
	ip?: string | null;
}

/** The event name the security dataset is queried by. */
const STAFF_READ_EVENT = "staff.conversation_read";

/** Minimum length of a typed reason, so "x" does not pass as a justification. */
const MIN_REASON_LENGTH = 8;
const MAX_REASON_LENGTH = 500;

/**
 * A typed reason, trimmed and checked. Null when it is missing or too short to say anything, which the
 * caller treats as "ask for one before showing content".
 */
export function acceptableReason(raw: string | null | undefined): string | null {
	const reason = (raw ?? "").replace(/\s+/g, " ").trim();
	if (reason.length < MIN_REASON_LENGTH) return null;
	return reason.slice(0, MAX_REASON_LENGTH);
}

/** Record one staff read of conversation content in both places. Never throws. */
export function recordStaffContentRead(read: StaffContentRead): void {
	const ipHash = hashIp(read.ip, "admin-audit");
	try {
		securityLogger.info(
			{
				event: STAFF_READ_EVENT,
				actor: read.actor,
				surface: read.surface,
				conversationIds: read.conversationIds,
				conversationCount: read.conversationIds.length,
				reason: read.reason,
				ipHash,
			},
			"[security] staff read conversation content"
		);
	} catch (e) {
		console.error("[staff-read] security log failed:", e);
	}
	logAdminActionSafe({
		actor: read.actor,
		action: read.surface,
		target: read.conversationIds.length === 1 ? read.conversationIds[0] : `${read.conversationIds.length} conversations`,
		summary: `reason: ${read.reason}`.slice(0, MAX_REASON_LENGTH + 10),
		ip: read.ip,
	});
}

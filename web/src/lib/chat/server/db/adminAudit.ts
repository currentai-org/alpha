/**
 * Admin action audit log — so config changes can be reconstructed and admin access reviewed.
 * Privacy/security conscious by construction: records WHO (admin username), WHAT (action + target), a
 * REDACTED summary (e.g. which keys changed — NEVER secret values or full config payloads), and a
 * HASHED IP. Append-only; retained. Backs the /admin/audit view.
 */
import { desc } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import { hashIp } from "./ipHash";
import { adminAudit, type AdminAuditRow } from "./schema";

export interface LogAdminActionInput {
	/** the signed-in admin (adminActor) — falls back to "admin" if unknown. */
	actor: string;
	/** dotted action name, e.g. "tuning.save", "rag.activate", "login". */
	action: string;
	/** what was acted on (a doc id, "tuning", etc.). */
	target?: string;
	/** REDACTED human summary — which keys changed, counts, etc. NEVER raw secret/config values. */
	summary?: string;
	/** raw client IP — hashed (domain-separated) before storage, never persisted in the clear. */
	ip?: string | null;
}

/** Persist one admin action. Throws on DB error — callers treat it as best-effort (an audit hiccup
 *  must never fail the admin action), so use logAdminActionSafe. */
export async function logAdminAction(input: LogAdminActionInput): Promise<void> {
	const db = getDb();
	await db.insert(adminAudit).values({
		id: newId(),
		actor: input.actor || "admin",
		action: input.action,
		target: input.target,
		summary: input.summary,
		ipHash: hashIp(input.ip, "admin-audit") ?? undefined,
	});
}

/** Fire-and-forget wrapper: never throws, never blocks the admin action on the audit write. */
export function logAdminActionSafe(input: LogAdminActionInput): void {
	logAdminAction(input).catch((e) => console.error("[admin-audit] log failed:", e));
}

/** Recent admin actions for /admin/audit. Read-only, newest first, bounded. */
export async function listAuditLog(limit = 200): Promise<AdminAuditRow[]> {
	const db = getDb();
	return db
		.select()
		.from(adminAudit)
		.orderBy(desc(adminAudit.createdAt))
		.limit(Math.max(1, Math.min(limit, 500)));
}

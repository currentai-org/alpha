/**
 * Report write point — the single place reports are persisted. A trust-and-safety triage consumer
 * attaches by READING the `reports` table; nothing upstream of the table needs to change.
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import type { AnswerReportReason, ReportStatus } from "../../reportReasons";
import { reports, type ReportRow } from "./schema";

// A report carries EITHER a per-answer `reason` (+ conversationId) OR a general `category` — see the
// schema note. Both channels go through this one write point.
export interface SaveReportInput {
	conversationId?: string;
	messageId?: string;
	userId?: string;
	sessionId?: string;
	reason?: AnswerReportReason;
	category?: "bug" | "ux" | "content" | "other";
	detail?: string;
	answerText?: string;
	answerModel?: string;
}

export async function saveReport(input: SaveReportInput): Promise<ReportRow> {
	const db = getDb();
	const [row] = await db
		.insert(reports)
		.values({
			id: newId(),
			conversationId: input.conversationId,
			messageId: input.messageId,
			userId: input.userId,
			sessionId: input.sessionId,
			reason: input.reason,
			category: input.category,
			detail: input.detail,
			answerText: input.answerText,
			answerModel: input.answerModel,
		})
		.returning();
	return row;
}

/**
 * Read the most recent reports for the admin dashboard (/admin/reports). Read-only; newest first;
 * bounded so the page can't pull the whole table. The same ROOST-seam rows saveReport writes — both
 * the per-answer report button AND the general "report a problem" channel land here.
 */
export async function listReports(limit = 200): Promise<ReportRow[]> {
	const db = getDb();
	return db
		.select()
		.from(reports)
		.orderBy(desc(reports.createdAt))
		.limit(Math.max(1, Math.min(limit, 500)));
}

/** The ids of the reports filed against one conversation, oldest first. A reviewer opening the
 *  conversation cites these as the reason for the read (CUR-4385). */
export async function reportIdsForConversation(conversationId: string): Promise<string[]> {
	const db = getDb();
	const rows = await db
		.select({ id: reports.id })
		.from(reports)
		.where(eq(reports.conversationId, conversationId))
		.orderBy(reports.createdAt)
		.limit(20);
	return rows.map((r) => r.id);
}

/** Who is asking for their own reports: a signed-in user, or a guest known only by session. */
export type ReportOwner = { userId: string } | { sessionId: string };

/** One of the visitor's own reports, as their reports page shows it: no other person's fields. */
export type OwnReport = Pick<
	ReportRow,
	"id" | "conversationId" | "reason" | "category" | "detail" | "status" | "statusUpdatedAt" | "createdAt"
>;

/**
 * The reports this visitor sent, newest first (CUR-3903). A signed-in user gets the rows carrying
 * their user id. A guest gets their session's rows that carry no user id, so a session that later
 * signed in never shows a guest the reports filed under the account.
 */
export async function listOwnReports(owner: ReportOwner, limit = 100): Promise<OwnReport[]> {
	const db = getDb();
	const where =
		"userId" in owner
			? eq(reports.userId, owner.userId)
			: and(eq(reports.sessionId, owner.sessionId), isNull(reports.userId));
	return db
		.select({
			id: reports.id,
			conversationId: reports.conversationId,
			reason: reports.reason,
			category: reports.category,
			detail: reports.detail,
			status: reports.status,
			statusUpdatedAt: reports.statusUpdatedAt,
			createdAt: reports.createdAt,
		})
		.from(reports)
		.where(where)
		.orderBy(desc(reports.createdAt))
		.limit(Math.max(1, Math.min(limit, 200)));
}

/** Record what staff decided about a report. Returns false when no report has that id. */
export async function setReportStatus(id: string, status: ReportStatus): Promise<boolean> {
	const db = getDb();
	const rows = await db
		.update(reports)
		.set({ status, statusUpdatedAt: new Date() })
		.where(eq(reports.id, id))
		.returning({ id: reports.id });
	return rows.length > 0;
}

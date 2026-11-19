/**
 * Safety-event log — the queryable record of turns the in-app moderation gate DECLINED (Coop child /
 * content + in-app prompt-injection). A decline otherwise only stamps message.moderation inside the
 * conversation JSONB, which isn't queryable; this table backs the /admin/safety declines view.
 * Stores ONLY verdict metadata (kind / label / score / ids) — never the user's text.
 *
 * A row with `probe` set came from a scheduled production probe (probeMarker.ts). Every read below that
 * counts or lists declines leaves those rows out, so they move no alert, hold no account and stay off
 * /admin/safety; a visitor's row has `probe` null and is counted.
 */
import { and, count, desc, eq, gte, isNull, not } from "drizzle-orm";
import { getDb } from "./client";
import { newId } from "./ids";
import { safetyEvents, type SafetyEventRow } from "./schema";

export interface LogDeclineInput {
	kind: "child_safety" | "prompt_injection" | "content_policy" | "toxicity";
	conversationId?: string;
	messageId?: string;
	userId?: string;
	sessionId?: string;
	label?: string;
	score?: number;
	/** The verified production probe that sent the turn (probeMarker.ts); absent for every other turn. */
	probe?: string;
}

/** Persist one decline. Throws on DB error — callers MUST treat it as best-effort (a logging hiccup
 *  must never fail the user's turn), so use logDeclineSafe on the hot path. */
export async function logDecline(input: LogDeclineInput): Promise<void> {
	const db = getDb();
	await db.insert(safetyEvents).values({
		id: newId(),
		kind: input.kind,
		conversationId: input.conversationId,
		messageId: input.messageId,
		userId: input.userId,
		sessionId: input.sessionId,
		label: input.label,
		score: input.score,
		probe: input.probe,
	});
}

/** Fire-and-forget wrapper for the chat hot path: never throws, never blocks the turn on a log write. */
export function logDeclineSafe(input: LogDeclineInput): void {
	logDecline(input).catch((e) => console.error("[safety-events] decline log failed:", e));
}

/** Recent visitor declines for /admin/safety (probe rows left out). Read-only, newest first, bounded. */
export async function listDeclines(limit = 200): Promise<SafetyEventRow[]> {
	const db = getDb();
	return db
		.select()
		.from(safetyEvents)
		.where(isNull(safetyEvents.probe))
		.orderBy(desc(safetyEvents.createdAt))
		.limit(Math.max(1, Math.min(limit, 500)));
}

// ── Fail-closed child-safety declines ───────────────────────────────────────────────────────────
// `checkChildSafety` fails CLOSED on an UNKNOWN Coop verdict: unreachable / 5xx / timeout / bad shape
// ⇒ every turn is declined, and it presents to the user as THE ASSISTANT REFUSING THEM, not as an
// outage. Nothing else goes red — the app, the model and the DB are all up and serving — so this
// failure needs its own signal.
//
// The table stores no text by design, so the rows cannot tell you who was on the other end.
// `user_id` is non-null on every row, but a distinct count of it does not mean that many real
// people: load tests carry user ids too. Decline rates under a fail-closed screen are partial rather
// than ~100%, and generation volume does not predict them.
//
// THE DISCRIMINATOR (the log call in routes/chat/conversation/[id]/+server.ts writes
// `label: moderation.auditCategory ?? moderation.label`):
//   • a REAL Coop child block sets auditCategory to the raw Coop action ⇒ label is that action code
//   • the fail-closed UNKNOWN path has NO category (moderation.ts) ⇒ label falls back to the
//     literal "child_safety"
// So `kind = 'child_safety' AND label = 'child_safety'` is exactly the fail-closed set, and a genuine
// detection never matches it. This is an availability signal, not a moderation signal — do not
// repurpose it to count real blocks.

/** Fail-closed child-safety declines in the last `windowMs`. The alerting probe's numerator. */
export async function countFailClosedChildDeclines(windowMs: number): Promise<number> {
	const since = new Date(Date.now() - windowMs);
	const [row] = await getDb()
		.select({ n: count() })
		.from(safetyEvents)
		.where(
			and(
				eq(safetyEvents.kind, "child_safety"),
				// The fallback label, NOT a raw Coop action ⇒ no rule fired ⇒ UNKNOWN verdict.
				eq(safetyEvents.label, "child_safety"),
				gte(safetyEvents.createdAt, since),
				// A probe's turn is not a visitor's; the alert counts what visitors met.
				isNull(safetyEvents.probe)
			)
		);
	return row?.n ?? 0;
}

/** True when the account had a real decline since `since`: any decline but a probe's row and the
 *  fail-closed child-safety rows above, which say the screen was down, not that the person did anything. Holds a run-code
 *  account on its first usage tier. Throws on DB error; the caller decides. */
export async function accountDeclinedSince(userId: string, since: Date): Promise<boolean> {
	const [row] = await getDb()
		.select({ n: count() })
		.from(safetyEvents)
		.where(
			and(
				eq(safetyEvents.userId, userId),
				gte(safetyEvents.createdAt, since),
				isNull(safetyEvents.probe),
				not(and(eq(safetyEvents.kind, "child_safety"), eq(safetyEvents.label, "child_safety"))!)
			)
		);
	return (row?.n ?? 0) > 0;
}

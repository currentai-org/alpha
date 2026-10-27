/**
 * W2 — generationId idempotency ledger.
 *
 * A turn is keyed by its client-minted `generationId` (UUID, minted once per logical turn and reused
 * unchanged across a network auto-retry of THAT turn — W3). This module is the server-side guard that
 * makes a re-sent POST safe: a duplicate must NOT spawn a second parallel generation.
 *
 * `claimGeneration` is a single atomic statement so concurrent attempts can't both win:
 *   INSERT … ON CONFLICT (id) DO UPDATE SET status='in_flight' … WHERE generations.status='error'
 *     - no existing row        → INSERT runs            → RETURNING yields the row → claimed (fresh)
 *     - existing row, status='error'  → DO UPDATE runs (WHERE passes) → RETURNING yields → claimed (retry)
 *     - existing row, complete/in_flight → DO UPDATE skipped (WHERE fails) → no row → NOT claimed → 409
 *
 * Written via raw drizzle (the Mongo-shaped `collections` facade can't express ON CONFLICT). `generations`
 * is a plain relational table (schema.ts), not a document collection.
 */
import { getDb } from "$lib/chat/server/db/client";
import { sql } from "drizzle-orm";

export type GenerationStatus = "in_flight" | "complete" | "error";

/**
 * Atomically claim this generationId for the current attempt. Returns true if we own it (a fresh
 * insert, or a re-claim of a previously-errored attempt); false if a complete/in-flight row already
 * exists — in which case the caller returns 409 and the client attaches to the existing run.
 */
export async function claimGeneration(
	id: string,
	conversationId: string,
	messageId: string
): Promise<boolean> {
	const rows = await getDb().execute(sql`
		INSERT INTO generations (id, conversation_id, message_id, status, created_at)
		VALUES (${id}, ${conversationId}, ${messageId}, 'in_flight', now())
		ON CONFLICT (id) DO UPDATE
			SET status = 'in_flight', message_id = excluded.message_id, created_at = now(), completed_at = NULL
			WHERE generations.status = 'error'
		RETURNING id
	`);
	return (rows as unknown as unknown[]).length > 0;
}

/** Read the current status of a generation (for the 409 body so the client knows whether to wait
 *  for the in-flight stream or just refresh a completed turn). Null if unknown. */
export async function readGeneration(
	id: string
): Promise<{ status: GenerationStatus; messageId: string | null } | null> {
	const rows = (await getDb().execute(sql`
		SELECT status, message_id FROM generations WHERE id = ${id}
	`)) as unknown as Array<{ status: GenerationStatus; message_id: string | null }>;
	const r = rows[0];
	return r ? { status: r.status, messageId: r.message_id } : null;
}

/** Whether a recent generation writing one of these messages is still in flight. The five-minute
 *  window keeps a row orphaned by a crashed turn from holding up later turns on the conversation. */
export async function answersInFlight(conversationId: string, messageIds: string[]): Promise<boolean> {
	const rows = (await getDb().execute(sql`
		SELECT 1 FROM generations
		WHERE conversation_id = ${conversationId}
			AND message_id IN (${sql.join(
				messageIds.map((id) => sql`${id}`),
				sql`, `
			)})
			AND status = 'in_flight'
			AND created_at > now() - interval '5 minutes'
		LIMIT 1
	`)) as unknown as unknown[];
	return rows.length > 0;
}

/** Mark a claimed generation terminal. 'complete' (incl. a user-interrupted turn — a finished answer
 *  was persisted) or 'error' (a future retry with the same id may re-claim it via claimGeneration). */
export async function finishGeneration(id: string, status: "complete" | "error"): Promise<void> {
	await getDb().execute(sql`
		UPDATE generations SET status = ${status}, completed_at = now() WHERE id = ${id}
	`);
}

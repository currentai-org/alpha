// The stream-follow event log's table access (schema.ts `generationEvents`). Raw drizzle,
// like generations.ts. The batching and the follow loop live elsewhere; this file is only the SQL.
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import { getDb } from "./client";
import * as schema from "./schema";

export type GenerationEventRow = { seq: number; payload: string };

/** Append one batch. A repeated (generation, seq) is ignored, so a retried flush cannot duplicate. */
export async function insertGenerationEvents(
	generationId: string,
	conversationId: string,
	seq: number,
	payload: string
): Promise<void> {
	await getDb()
		.insert(schema.generationEvents)
		.values({ generationId, conversationId, seq, payload })
		.onConflictDoNothing();
}

/** Batches of a generation after `afterSeq` (exclusive), in order. */
export async function readGenerationEvents(
	generationId: string,
	afterSeq: number
): Promise<GenerationEventRow[]> {
	return getDb()
		.select({ seq: schema.generationEvents.seq, payload: schema.generationEvents.payload })
		.from(schema.generationEvents)
		.where(
			and(
				eq(schema.generationEvents.generationId, generationId),
				gt(schema.generationEvents.seq, afterSeq)
			)
		)
		.orderBy(asc(schema.generationEvents.seq));
}

/** Whether any batch of this generation exists, and the newest write time. */
export async function generationLogState(
	generationId: string
): Promise<{ count: number; lastAt: Date | null }> {
	const rows = await getDb()
		.select({ createdAt: schema.generationEvents.createdAt })
		.from(schema.generationEvents)
		.where(eq(schema.generationEvents.generationId, generationId))
		.orderBy(asc(schema.generationEvents.seq));
	return { count: rows.length, lastAt: rows.length ? rows[rows.length - 1].createdAt : null };
}

/** Every batch still held for these conversations, for the data export. Callers pass only ids the
 *  person owns: this filters by conversation alone. */
export async function generationEventsForConversations(conversationIds: string[]): Promise<
	{ generationId: string; conversationId: string; seq: number; payload: string; createdAt: Date }[]
> {
	if (conversationIds.length === 0) return [];
	return getDb()
		.select({
			generationId: schema.generationEvents.generationId,
			conversationId: schema.generationEvents.conversationId,
			seq: schema.generationEvents.seq,
			payload: schema.generationEvents.payload,
			createdAt: schema.generationEvents.createdAt,
		})
		.from(schema.generationEvents)
		.where(inArray(schema.generationEvents.conversationId, conversationIds))
		.orderBy(asc(schema.generationEvents.conversationId), asc(schema.generationEvents.generationId), asc(schema.generationEvents.seq));
}

export async function deleteGenerationEvents(generationId: string): Promise<number> {
	const rows = await getDb()
		.delete(schema.generationEvents)
		.where(eq(schema.generationEvents.generationId, generationId))
		.returning({ seq: schema.generationEvents.seq });
	return rows.length;
}

/** The TTL sweep: batches written before `cutoff`, whatever became of their turn. */
export async function sweepGenerationEvents(cutoff: Date): Promise<number> {
	const rows = await getDb()
		.delete(schema.generationEvents)
		.where(lt(schema.generationEvents.createdAt, cutoff))
		.returning({ seq: schema.generationEvents.seq });
	return rows.length;
}

/** The generations row the follow route needs: which conversation and message it belongs to, and
 *  whether it has ended. Null for an id nobody claimed. */
export async function readGenerationForFollow(generationId: string): Promise<{
	conversationId: string;
	messageId: string | null;
	status: "in_flight" | "complete" | "error";
} | null> {
	const rows = await getDb()
		.select({
			conversationId: schema.generations.conversationId,
			messageId: schema.generations.messageId,
			status: schema.generations.status,
		})
		.from(schema.generations)
		.where(eq(schema.generations.id, generationId));
	return rows[0] ?? null;
}

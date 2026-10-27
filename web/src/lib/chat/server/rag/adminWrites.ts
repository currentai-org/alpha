// Admin write/lifecycle for the RAG upload feature (Phase 2): create(draft) / update(metadata) /
// activate / retire, each writing an immutable rag_document_audit row. Mutations are TRANSACTIONAL
// so the denormalized rag_chunks.active flag stays consistent with the parent status.
//
// OPTIMISTIC CONCURRENCY (same intent as tuning.setTuning, but keyed on the monotonic `version`
// integer rather than a timestamp, since timestamps aren't unique): a write supplies the `version`
// it loaded; the conditional UPDATE lands only while the stored version still matches, else
// RagConflictError, and the row's version is incremented. Every write also sets updatedAt = editedAt
// = a JS `new Date()`; the updatedAt bump feeds the adminStore watermark (editedAt is display/audit).
//
// EMBEDDING happens at write time (batched via embedTexts), strictly BEFORE the transaction, so a failed
// embedding never persists: a document is created with ALL chunks embedded (as inactive drafts) or
// the write throws and nothing lands. Activation (a separate explicit step) is what flips chunks
// active, so there is never an active chunk without a vector.
//
// TESTING POSTURE: the pure pieces are unit-tested in the hermetic gate (chunking, the cosine
// ranking, the citation/injection helpers). These DB-write paths — OCC conflict, transaction
// rollback, the active-flag flip, the raw aggregates — need a LIVE Postgres and are NOT covered by
// the hermetic suite; db/__tests__/*.spec.ts run only with DATABASE_URL set. The error classes below map cleanly to HTTP codes so a
// route handler can surface them.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { getDb } from "$lib/chat/server/db/client";
import { newId } from "$lib/chat/server/db/ids";
import {
	ragChunks,
	ragDocuments,
	ragDocumentAudit,
	type RagDocumentRow,
} from "$lib/chat/server/db/schema";
import { embedTexts } from "./embed";
import { embeddingModel, maxChunksPerDoc } from "./env";
import { chunkDocumentText } from "./chunking";
import { commentResidueReason } from "./commentResidue";

/** A concurrent editor changed the document since it was loaded (OCC miss) → caller returns 409. */
export class RagConflictError extends Error {
	constructor(
		readonly editedBy?: string | null,
		readonly editedAt?: string | null
	) {
		super("This document was changed since you loaded it. Reload and retry.");
		this.name = "RagConflictError";
	}
}

/** The target document does not exist → caller returns 404. */
export class RagNotFoundError extends Error {
	constructor(readonly id: string) {
		super("Document not found.");
		this.name = "RagNotFoundError";
	}
}

/** A precondition for the transition failed (e.g. activating a chunkless doc) → caller returns 400. */
export class RagWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RagWriteError";
	}
}

// Per-document chunk cap (RAG_ADMIN_MAX_CHUNKS_PER_DOC, default 50) bounds the sequential embed loop
// so one paste/upload can't flood the active set or blow the serverless time budget.

export type CreateRagDocumentInput = {
	title: string;
	text: string;
	source: string;
	url?: string | null;
	sourceType?: string | null;
	sourceDate?: string | null; // ISO date
};

export type UpdateRagDocumentMeta = {
	title?: string;
	source?: string;
	url?: string | null;
	sourceType?: string | null;
	sourceDate?: string | null;
};

function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

// Embed in BATCHES (one HTTP call per EMBED_BATCH chunks) rather than one call per chunk, so a large
// document doesn't pin the serverless function with a long sequential loop (the timeout risk). One
// retry per batch absorbs a transient HF hiccup; a hard failure still throws BEFORE any DB write.
const EMBED_BATCH = 32;

async function embedBatchOrThrow(texts: string[], failMessage: string): Promise<number[][]> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const vectors = await embedTexts(texts);
		if (vectors && vectors.length === texts.length) return vectors;
		if (attempt === 0) await new Promise((r) => setTimeout(r, 600));
	}
	throw new RagWriteError(failMessage);
}

/** Chunk + embed the text up front (OUTSIDE any transaction). Throws if there is nothing to embed,
 *  the per-doc cap is exceeded, or ANY embedding fails — so a partial/vectorless doc never persists. */
async function embedChunks(
	text: string
): Promise<Array<{ text: string; vector: number[]; dim: number; hash: string }>> {
	const pieces = chunkDocumentText(text);
	if (pieces.length === 0) {
		throw new RagWriteError("Document has no embeddable text.");
	}
	const maxChunks = maxChunksPerDoc();
	if (pieces.length > maxChunks) {
		throw new RagWriteError(
			`Document is too large: ${pieces.length} chunks (max ${maxChunks}). Split it into smaller items, or raise RAG_ADMIN_MAX_CHUNKS_PER_DOC.`
		);
	}
	const out: Array<{ text: string; vector: number[]; dim: number; hash: string }> = [];
	for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
		const batch = pieces.slice(i, i + EMBED_BATCH);
		const vectors = await embedBatchOrThrow(
			batch,
			"Embedding failed for a chunk; document not saved — try again."
		);
		batch.forEach((piece, j) => {
			out.push({
				text: piece,
				vector: vectors[j],
				dim: vectors[j].length,
				hash: contentHash(piece),
			});
		});
	}
	return out;
}

function isoOrNull(d: Date | null | undefined): string | null {
	return d ? d.toISOString() : null;
}

/** Small, date-safe audit snapshot of a document row (Dates → ISO so the JSONB stays clean). */
function snapshotOf(row: RagDocumentRow): Record<string, unknown> {
	return {
		title: row.title,
		source: row.source,
		url: row.url,
		sourceType: row.sourceType,
		sourceDate: isoOrNull(row.sourceDate),
		status: row.status,
		version: row.version,
		editedAt: isoOrNull(row.editedAt),
	};
}

/** Create a DRAFT document with its embedded (inactive) chunks + a 'create' audit row. Returns the
 *  doc plus `duplicateChunkCount` — a WARN-ONLY signal (count of new chunk hashes already present in
 *  the store), never a block: identical text can legitimately recur across items or re-uploads. */
export async function createRagDocument(
	input: CreateRagDocumentInput,
	byUser: string | null
): Promise<{ doc: RagDocumentRow; duplicateChunkCount: number }> {
	// Before embedding, so a refused upload costs no embedding call (CUR-2634).
	const residue = commentResidueReason(input.text);
	if (residue) throw new RagWriteError(residue);
	const embedded = await embedChunks(input.text); // may throw — nothing persisted yet
	const model = embeddingModel();
	const docId = newId();
	const at = new Date();
	return getDb().transaction(async (tx) => {
		// Warn-only dedup: how many of these content hashes already exist anywhere in the store.
		const hashes = embedded.map((c) => c.hash);
		const existing = await tx
			.selectDistinct({ h: ragChunks.contentHash })
			.from(ragChunks)
			.where(inArray(ragChunks.contentHash, hashes));
		const duplicateChunkCount = existing.length;

		const [doc] = await tx
			.insert(ragDocuments)
			.values({
				id: docId,
				title: input.title,
				url: input.url ?? null,
				source: input.source,
				sourceType: input.sourceType ?? null,
				sourceDate: input.sourceDate ? new Date(input.sourceDate) : null,
				status: "draft",
				createdBy: byUser,
				createdAt: at,
				updatedAt: at,
				editedAt: at, // last-edit timestamp; version is the OCC token
				version: 1,
			})
			.returning();
		await tx.insert(ragChunks).values(
			embedded.map((c, i) => ({
				id: newId(),
				documentId: docId,
				chunkIndex: i,
				text: c.text,
				vector: c.vector,
				embeddingModel: model,
				dim: c.dim,
				contentHash: c.hash,
				active: false,
			}))
		);
		await tx.insert(ragDocumentAudit).values({
			id: newId(),
			documentId: docId,
			action: "create",
			byUser,
			toStatus: "draft",
			snapshot: snapshotOf(doc),
		});
		return { doc, duplicateChunkCount };
	});
}

/** Read the current row (for fromStatus / not-found) and run the OCC conditional update in one tx.
 *  Returns { before, updated }; throws RagNotFoundError / RagConflictError. `extra` are additional
 *  column writes for the specific transition (status, approvedBy, …). */
async function occUpdate(
	tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
	id: string,
	expectedVersion: number,
	extra: Record<string, unknown>
): Promise<{ before: RagDocumentRow; updated: RagDocumentRow }> {
	const [before] = await tx.select().from(ragDocuments).where(eq(ragDocuments.id, id));
	if (!before) throw new RagNotFoundError(id);
	const at = new Date();
	// OCC guard on the monotonic `version` (not editedAt): an integer that strictly increments per
	// write, so — unlike a timestamp — two writes can never share a token even in the same millisecond.
	const [updated] = await tx
		.update(ragDocuments)
		.set({ ...extra, updatedAt: at, editedAt: at, version: sql`${ragDocuments.version} + 1` })
		.where(and(eq(ragDocuments.id, id), eq(ragDocuments.version, expectedVersion)))
		.returning();
	if (!updated) throw new RagConflictError(before.createdBy, isoOrNull(before.editedAt));
	return { before, updated };
}

/** Update editable METADATA (not text/chunks — re-embedding is the Phase-3 re-embed job). OCC-guarded. */
export async function updateRagDocument(
	id: string,
	patch: UpdateRagDocumentMeta,
	expectedVersion: number,
	byUser: string | null
): Promise<RagDocumentRow> {
	const extra: Record<string, unknown> = {};
	if (patch.title !== undefined) extra.title = patch.title;
	if (patch.source !== undefined) extra.source = patch.source;
	if (patch.url !== undefined) extra.url = patch.url ?? null;
	if (patch.sourceType !== undefined) extra.sourceType = patch.sourceType ?? null;
	if (patch.sourceDate !== undefined)
		extra.sourceDate = patch.sourceDate ? new Date(patch.sourceDate) : null;

	return getDb().transaction(async (tx) => {
		const { before, updated } = await occUpdate(tx, id, expectedVersion, extra);
		await tx.insert(ragDocumentAudit).values({
			id: newId(),
			documentId: id,
			action: "edit",
			byUser,
			fromStatus: before.status,
			toStatus: updated.status,
			snapshot: snapshotOf(before),
		});
		return updated;
	});
}

/** Activate a document: stamp approval, flip its chunks active, audit. Requires ≥1 embedded chunk.
 *  Allowed from draft OR retired — re-activating a retired doc un-retires it (retire is a REVERSIBLE
 *  soft-delete; the chunks were only deactivated, never deleted). */
export async function activateRagDocument(
	id: string,
	expectedVersion: number,
	byUser: string | null
): Promise<RagDocumentRow> {
	const at = new Date();
	return getDb().transaction(async (tx) => {
		const [{ c: chunkCount } = { c: 0 }] = await tx
			.select({ c: sql<number>`count(*)::int` })
			.from(ragChunks)
			.where(eq(ragChunks.documentId, id));
		if (!chunkCount) {
			// Distinguish not-found from chunkless so the route maps the right code.
			const [exists] = await tx
				.select({ id: ragDocuments.id })
				.from(ragDocuments)
				.where(eq(ragDocuments.id, id));
			if (!exists) throw new RagNotFoundError(id);
			throw new RagWriteError("Cannot activate a document with no embedded chunks.");
		}
		const { before, updated } = await occUpdate(tx, id, expectedVersion, {
			status: "active",
			approvedBy: byUser,
			approvedAt: at,
		});
		await tx.update(ragChunks).set({ active: true }).where(eq(ragChunks.documentId, id));
		await tx.insert(ragDocumentAudit).values({
			id: newId(),
			documentId: id,
			action: "activate",
			byUser,
			fromStatus: before.status,
			toStatus: "active",
			snapshot: snapshotOf(before),
		});
		return updated;
	});
}

/** Retire a document (REVERSIBLE soft delete): status→retired, deactivate its chunks (kept, not
 *  deleted, so activate can restore them), audit. OCC-guarded. */
export async function retireRagDocument(
	id: string,
	expectedVersion: number,
	byUser: string | null
): Promise<RagDocumentRow> {
	return getDb().transaction(async (tx) => {
		const { before, updated } = await occUpdate(tx, id, expectedVersion, { status: "retired" });
		await tx.update(ragChunks).set({ active: false }).where(eq(ragChunks.documentId, id));
		await tx.insert(ragDocumentAudit).values({
			id: newId(),
			documentId: id,
			action: "retire",
			byUser,
			fromStatus: before.status,
			toStatus: "retired",
			snapshot: snapshotOf(before),
		});
		return updated;
	});
}

/** Re-embed a document's existing chunk texts with the CURRENT embedding model — the recovery for a
 *  global RAG_EMBEDDING_MODEL change (after which the adminStore's `embedding_model = $model` filter
 *  would otherwise stop serving the doc's now-stale-model chunks). Re-chunking is NOT done (texts are
 *  preserved); each chunk's vector/embeddingModel/dim is rewritten in place. Embeds BEFORE the tx, so
 *  a failure changes nothing. OCC-guarded; status is preserved (active chunks stay active). */
export async function reembedRagDocument(
	id: string,
	expectedVersion: number,
	byUser: string | null
): Promise<RagDocumentRow> {
	const db = getDb();
	const chunks = await db
		.select({ id: ragChunks.id, text: ragChunks.text })
		.from(ragChunks)
		.where(eq(ragChunks.documentId, id))
		.orderBy(ragChunks.chunkIndex);
	if (chunks.length === 0) {
		// Either the doc doesn't exist or has no chunks; occUpdate below resolves not-found vs conflict.
		const [exists] = await db
			.select({ id: ragDocuments.id })
			.from(ragDocuments)
			.where(eq(ragDocuments.id, id));
		if (!exists) throw new RagNotFoundError(id);
		throw new RagWriteError("Document has no chunks to re-embed.");
	}
	const model = embeddingModel();
	const embedded: Array<{ id: string; vector: number[]; dim: number }> = [];
	for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
		const batch = chunks.slice(i, i + EMBED_BATCH);
		const vectors = await embedBatchOrThrow(
			batch.map((c) => c.text),
			"Re-embedding failed for a chunk; nothing changed — try again."
		);
		batch.forEach((c, j) =>
			embedded.push({ id: c.id, vector: vectors[j], dim: vectors[j].length })
		);
	}
	return db.transaction(async (tx) => {
		const { before, updated } = await occUpdate(tx, id, expectedVersion, {}); // version++/updatedAt
		for (const e of embedded) {
			await tx
				.update(ragChunks)
				.set({ vector: e.vector, embeddingModel: model, dim: e.dim })
				.where(eq(ragChunks.id, e.id));
		}
		await tx.insert(ragDocumentAudit).values({
			id: newId(),
			documentId: id,
			action: "reembed",
			byUser,
			fromStatus: before.status,
			toStatus: updated.status,
			snapshot: snapshotOf(before),
		});
		return updated;
	});
}

export type RagAuditItem = {
	id: string;
	action: "create" | "edit" | "activate" | "retire" | "reembed";
	byUser: string | null;
	at: Date | null;
	fromStatus: string | null;
	toStatus: string | null;
};

/** The immutable audit trail for one document, newest first (for the admin audit view). */
export async function getRagDocumentAudit(documentId: string, limit = 50): Promise<RagAuditItem[]> {
	return getDb()
		.select({
			id: ragDocumentAudit.id,
			action: ragDocumentAudit.action,
			byUser: ragDocumentAudit.byUser,
			at: ragDocumentAudit.at,
			fromStatus: ragDocumentAudit.fromStatus,
			toStatus: ragDocumentAudit.toStatus,
		})
		.from(ragDocumentAudit)
		.where(eq(ragDocumentAudit.documentId, documentId))
		.orderBy(desc(ragDocumentAudit.at))
		.limit(limit);
}

export type RagDocumentListItem = {
	id: string;
	title: string;
	url: string | null;
	source: string;
	sourceType: string | null;
	sourceDate: Date | null;
	status: "draft" | "active" | "retired";
	createdBy: string | null;
	approvedBy: string | null;
	approvedAt: Date | null;
	createdAt: Date | null;
	updatedAt: Date | null;
	editedAt: Date | null;
	version: number;
	chunkCount: number;
	activeChunkCount: number;
};

/** List documents (newest first) with chunk counts, for the admin table. */
export async function listRagDocuments(): Promise<RagDocumentListItem[]> {
	return getDb()
		.select({
			id: ragDocuments.id,
			title: ragDocuments.title,
			url: ragDocuments.url,
			source: ragDocuments.source,
			sourceType: ragDocuments.sourceType,
			sourceDate: ragDocuments.sourceDate,
			status: ragDocuments.status,
			createdBy: ragDocuments.createdBy,
			approvedBy: ragDocuments.approvedBy,
			approvedAt: ragDocuments.approvedAt,
			createdAt: ragDocuments.createdAt,
			updatedAt: ragDocuments.updatedAt,
			editedAt: ragDocuments.editedAt,
			version: ragDocuments.version,
			chunkCount: sql<number>`count(${ragChunks.id})::int`,
			activeChunkCount: sql<number>`count(${ragChunks.id}) FILTER (WHERE ${ragChunks.active})::int`,
		})
		.from(ragDocuments)
		.leftJoin(ragChunks, eq(ragChunks.documentId, ragDocuments.id))
		.groupBy(ragDocuments.id)
		.orderBy(desc(ragDocuments.updatedAt))
		.limit(500);
}

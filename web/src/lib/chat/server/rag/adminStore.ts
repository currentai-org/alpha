// Admin-authored RAG store: in-memory cosine search over the `active` rows of the
// rag_chunks table (the upload feature; see docs/plan-rag-admin-upload.md). Sibling to the
// committed catalog store (localStore.ts) — same cosine scan, but the corpus is editable
// Postgres rows instead of a build artifact, so it carries a serverless-safe cache.
//
// FAIL-CLOSED BY RETURN: gated OFF by default (RAG_ADMIN_ENABLED); any DB error, a missing
// query embedding, or no active chunks all return [] so the turn answers normally. The
// orchestrator additionally wraps this in a reject-safe withTimeout, so this store can never
// block or break a turn.
//
// SERVERLESS-SAFE CACHE: Vercel instances do not share memory, so a naive
// per-instance TTL cache could keep serving a chunk another instance just retired. Each turn we
// probe a cheap DB watermark and reuse the in-process chunk cache ONLY if the watermark is
// unchanged; a retire/activate/edit thus propagates within one turn across all instances. A hard
// TTL is a backstop floor and adminMaxChunks caps the reload.
//
// WATERMARK = active-doc count + SUM + MAX of the active updatedAt (integer ms). The sum is what
// makes an edit to a NON-newest active document detectable: count and max can both stay fixed, but
// any write bumps that row's updated_at to now() (monotonic), so the sum strictly increases. This
// relies on the writer contract that every create/edit/activate/retire/re-embed sets
// rag_documents.updated_at = now() (Phase 2/3 write paths MUST honor this; the seed does via
// defaultNow()).
//
// WORKSPACE SCOPE (CUR-4152): `rag_documents.organization_id` NULL is the site-wide corpus; a value
// marks one workspace's own document. Every read here takes the asker's workspace and keeps
// site-wide documents plus that workspace's, never another's, and the cache is keyed per workspace
// so one workspace's chunks never sit in the set another turn reads. No workspace means site-wide only.

import type { RagSource } from "$lib/chat/types/Rag";
import { getDb } from "$lib/chat/server/db/client";
import { sql } from "drizzle-orm";
import { logger } from "$lib/chat/server/logger";
import { embedText } from "./embed";
import { rankByCosine, toSnippet, CURATED_SNIPPET_CAP, type Scored } from "./rank";
import {
	adminCacheTtlMs,
	adminMaxChunks,
	embeddingModel,
	localMinScore,
	localTopK,
	ragAdminEnabled,
} from "./env";

export type AdminChunk = {
	id: string;
	documentId: string;
	title: string;
	url: string | null;
	text: string;
	vector: number[];
	sourceDate: string | null;
	version: number;
};

/** The workspace whose documents a read may include besides the site-wide ones; null for none. */
export type RagWorkspace = string | null;

// One cached set per workspace, "" for site-wide only. Bounded so a burst of workspaces can't grow
// an instance's memory without limit; the oldest entry goes first.
const CACHE_SLOTS = 32;
const caches = new Map<string, { watermark: string; chunks: AdminChunk[]; at: number }>();

/** SQL that keeps site-wide documents and, when given, one workspace's own. */
function scopeFilter(workspaceId: RagWorkspace, column = sql.raw("organization_id")) {
	return workspaceId
		? sql`(${column} IS NULL OR ${column} = ${workspaceId})`
		: sql`${column} IS NULL`;
}

/** Cache-reuse decision, factored out as a PURE function so the serverless staleness invariant
 *  (a retire bumps the watermark → next turn reloads) is unit-testable without a DB. */
export function cacheIsFresh(
	current: { watermark: string; at: number } | null,
	watermark: string,
	now: number,
	ttlMs: number
): boolean {
	return !!current && current.watermark === watermark && now - current.at < ttlMs;
}

/** Shape a scored admin chunk into a citable source. Engine "Potluck:Community" so the UI labels
 *  it as admin-authored (never gap-map), carrying chunk/document provenance. Pure — unit-tested. */
export function toCommunitySource(chunk: AdminChunk, score: number): Omit<RagSource, "n"> {
	return {
		title: chunk.title,
		url: chunk.url ?? undefined,
		// Authored corpus, same as the local store. The ingest splits to CURATED_SNIPPET_CAP (the
		// chunkDocumentText default in chunking.ts; adminWrites.ts passes no bound), so this clamp does
		// not bite on admin chunks. No stripRecallTail here: the
		// tail is a local-index build artifact.
		snippet: toSnippet(chunk.text, CURATED_SNIPPET_CAP),
		engine: "Potluck:Community",
		score,
		chunkId: chunk.id,
		documentId: chunk.documentId,
		sourceDate: chunk.sourceDate ?? undefined,
		version: chunk.version,
	};
}

/** Cheap cross-instance invalidation key over the active documents: count + SUM + MAX of the
 *  updatedAt, in INTEGER milliseconds. Activate/retire changes the count; any edit bumps a row's
 *  updatedAt to now() (monotonic), so the SUM strictly increases even when the edited row is neither
 *  the newest nor changes the count (the hole a count+max-only watermark would miss). Integer-ms —
 *  NOT float seconds — so the sum is EXACT and order-independent: Postgres parallel aggregation can
 *  reorder a float sum and return a different value for identical data, which would spuriously bust
 *  the cache every turn. Relies on the writer contract that every create/edit/activate/retire/
 *  re-embed sets rag_documents.updated_at = now() (Phase 2/3 write paths MUST honor this; the seed
 *  does via defaultNow()). One indexed aggregate, no extra writes. */
async function probeWatermark(workspaceId: RagWorkspace): Promise<string> {
	const rows = (await getDb().execute(sql`
		SELECT
			count(*) FILTER (WHERE status = 'active')::int AS n,
			coalesce(sum((extract(epoch FROM updated_at) * 1000)::bigint) FILTER (WHERE status = 'active'), 0)::text AS s,
			coalesce((extract(epoch FROM max(updated_at) FILTER (WHERE status = 'active')) * 1000)::bigint, 0)::text AS w
		FROM rag_documents
		WHERE ${scopeFilter(workspaceId)}
	`)) as unknown as Array<{ n: number; s: string; w: string }>;
	const r = rows[0] ?? { n: 0, s: "0", w: "0" };
	return `${r.n}:${r.s}:${r.w}`;
}

/** Load the active chunks for the CURRENT embedding model (the model-identity guard, applied in
 *  SQL via the partial index), newest document first, capped. */
async function loadActiveChunks(workspaceId: RagWorkspace): Promise<AdminChunk[]> {
	const model = embeddingModel();
	const cap = adminMaxChunks();
	const rows = (await getDb().execute(sql`
		SELECT c.id, c.document_id, c.text, c.vector, d.title, d.url, d.source_date, d.version
		FROM rag_chunks c
		JOIN rag_documents d ON d.id = c.document_id
		WHERE c.active = true AND c.embedding_model = ${model} AND ${scopeFilter(workspaceId, sql.raw("d.organization_id"))}
		ORDER BY d.updated_at DESC
		LIMIT ${cap}
	`)) as unknown as Array<{
		id: string;
		document_id: string;
		text: string;
		vector: number[];
		title: string;
		url: string | null;
		source_date: string | Date | null;
		version: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		documentId: r.document_id,
		title: r.title,
		url: r.url,
		text: r.text,
		// Coerce defensively: postgres.js parses a real[] to number[], but a driver/type-OID edge
		// returning string elements would make cosine() do string math → NaN. Number() is a no-op
		// on numbers, so this is safe either way and runs only on a (rare) cache reload.
		vector: (r.vector as Array<number | string>).map(Number),
		sourceDate: r.source_date ? new Date(r.source_date).toISOString() : null,
		version: r.version,
	}));
}

/** Active chunks via the watermark-checked cache. Probes every turn (one cheap indexed query);
 *  reloads only when the watermark changed or the TTL backstop elapsed. */
async function getActiveChunks(workspaceId: RagWorkspace): Promise<AdminChunk[]> {
	const key = workspaceId ?? "";
	const watermark = await probeWatermark(workspaceId);
	const now = Date.now();
	const cached = caches.get(key) ?? null;
	if (cached && cacheIsFresh(cached, watermark, now, adminCacheTtlMs())) {
		return cached.chunks;
	}
	const chunks = await loadActiveChunks(workspaceId);
	caches.delete(key);
	caches.set(key, { watermark, chunks, at: now });
	if (caches.size > CACHE_SLOTS) caches.delete(caches.keys().next().value!);
	return chunks;
}

/** Shared core: load the active chunks, embed the query, cosine-rank. `minScore` lets the live path
 *  filter at localMinScore() while preview passes -Infinity to surface near-misses. THROWS on a DB
 *  or embed failure — callers decide whether to swallow (live: fail-open) or surface (preview). */
async function rankAdmin(
	query: string,
	minScore: number,
	workspaceId: RagWorkspace
): Promise<Scored<AdminChunk>[]> {
	const chunks = await getActiveChunks(workspaceId);
	if (!chunks.length) {
		return [];
	}
	const qv = await embedText(query);
	if (!qv) {
		return [];
	}
	return rankByCosine(qv, chunks, minScore, localTopK());
}

/**
 * Retrieve the top admin-authored chunks for a query as citable sources (without citation
 * numbers — the orchestrator assigns those when merging stores). Engine "Potluck:Community"
 * so the UI labels them as admin-authored, never as gap-map data. Fail-open: [] on any error.
 */
export async function queryAdminStore(
	query: string,
	workspaceId: RagWorkspace
): Promise<Omit<RagSource, "n">[]> {
	if (!ragAdminEnabled()) {
		return [];
	}
	try {
		const scored = await rankAdmin(query, localMinScore(), workspaceId);
		return scored.map(({ chunk, score }) => toCommunitySource(chunk, score));
	} catch (e) {
		logger.warn(e, "[rag] admin store query failed; skipping");
		return [];
	}
}

export type PreviewHit = Omit<RagSource, "n"> & { passes: boolean };

/**
 * Admin preview (route-gated, so NOT subject to RAG_ADMIN_ENABLED): rank a test query against the
 * LIVE active chunks exactly as a turn would, but show near-misses too (no min-score filter) and
 * annotate which pass localMinScore(). The passing subset, in order, is identical to what
 * queryAdminStore returns for the same query — same chunks, same embedding, same cosine — so the
 * preview faithfully predicts live retrieval. Surfaces errors (the route handler maps them to 5xx).
 */
export async function previewAdminQuery(
	query: string,
	workspaceId: RagWorkspace = null
): Promise<{ minScore: number; hits: PreviewHit[] }> {
	const minScore = localMinScore();
	const scored = await rankAdmin(query, Number.NEGATIVE_INFINITY, workspaceId);
	return {
		minScore,
		hits: scored.map(({ chunk, score }) => ({
			...toCommunitySource(chunk, score),
			passes: score >= minScore,
		})),
	};
}

// Local Tier-A vector store: in-memory cosine search over the committed,
// pre-embedded catalog index (scripts/build-rag-index.mjs). Tier A is small
// (~60 chunks of gap-map categories, exemplar repos, the stack-map narrative,
// and the project-context blurb), so a brute-force cosine scan is plenty — no
// pgvector/sqlite needed.
//
// FAIL-OPEN: an empty/missing index, a dimension mismatch, or a failed query
// embedding all return [] so the chat answers normally without local grounding.

import ragIndex from "./data/rag-index.json";
import type { RagSource } from "$lib/chat/types/Rag";
import { embedText } from "./embed";
import { rankByCosine, toSnippet, stripRecallTail, CURATED_SNIPPET_CAP } from "./rank";
import { embeddingModel, localMinScore, localTopK } from "./env";
import { logger } from "$lib/chat/server/logger";
import { readCatalogEntities } from "./catalogEntitiesFile";

type IndexChunk = {
	id: string;
	source: string;
	title: string;
	url?: string;
	text: string;
	vector: number[];
};

type RagIndex = {
	model: string;
	dim: number;
	builtAt: string;
	chunks: IndexChunk[];
};

const index = ragIndex as RagIndex;

// Both of these are STATIC facts once the process is up (the index is a static import; the active
// embedding model doesn't change turn to turn), so each warns once per process rather than on every
// query — the same posture openSearch.ts's warnedNoRerankerGrounding uses for the same reason: an
// unconditional per-turn warn would spam the log forever once either condition trips, without adding
// any new information after the first line. (CUR-879 — this reads as "the catalog has nothing
// relevant" turn after turn without either warning existing at all.)
let warnedEmptyIndex = false;
let warnedModelMismatch = false;

// Catalog products and organizations, one chunk each with its page url (CUR-888). ~1,750 chunks and
// ~8.5MB, so it is read from disk on the first retrieval rather than imported: a cold start that
// never retrieves never pays for it, and the build never parses it (CUR-2919). Built by
// `build-rag-index.mjs --entities` from the gap-map database, so it can trail the live catalog until
// the next rebuild.
let entityChunks: Promise<IndexChunk[]> | undefined;
function loadEntityChunks(): Promise<IndexChunk[]> {
	entityChunks ??= (async () => {
		const started = performance.now();
		try {
			const entities = (await readCatalogEntities()) as RagIndex & {
				publishedAt: string | null;
			};
			const usable = entities.model === index.model && entities.dim === index.dim;
			logger.info(
				{
					ms: Math.round(performance.now() - started),
					chunks: entities.chunks.length,
					publishedAt: entities.publishedAt,
					usable
				},
				usable
					? "[rag] catalog entity chunks loaded"
					: "[rag] catalog entity chunks were embedded with a different model or dimension than the index — skipped until rebuilt"
			);
			return usable ? entities.chunks : [];
		} catch (err) {
			logger.error({ err }, "[rag] catalog entity chunks failed to load — retrieval continues without them");
			return [];
		}
	})();
	return entityChunks;
}

/** How many catalog entity chunks retrieval ranks, loading them on first call; 0 when they failed. */
export async function catalogEntityChunkCount(): Promise<number> {
	return (await loadEntityChunks()).length;
}

/**
 * Retrieve the top catalog chunks for a query as citable sources (without
 * citation numbers — the orchestrator assigns those when merging stores).
 */
export async function queryLocalStore(query: string): Promise<Omit<RagSource, "n">[]> {
	if (!index.chunks?.length) {
		if (!warnedEmptyIndex) {
			warnedEmptyIndex = true;
			logger.error(
				{ builtAt: index.builtAt },
				"[rag] local catalog index is empty — every turn silently skips local grounding until it's rebuilt"
			);
		}
		return [];
	}
	// Model-identity guard: the committed index was embedded with index.model. If the active
	// embedding model has been swapped — even to one with the SAME dimension — the query vector
	// is not comparable, so skip the store rather than return silently-wrong cosine hits. (The
	// dim check below stays as a second line of defense.)
	if (index.model !== embeddingModel()) {
		if (!warnedModelMismatch) {
			warnedModelMismatch = true;
			logger.error(
				{ indexModel: index.model, activeModel: embeddingModel() },
				"[rag] local catalog index was built with a different embedding model than is active now — every turn silently skips local grounding until the index is rebuilt or the model is reverted (CUR-113's failure shape, different subsystem)"
			);
		}
		return [];
	}
	const qv = await embedText(query);
	if (!qv) {
		// Per-query, not warn-once: an embed-call failure is a live operational event that can resolve
		// and recur, unlike the two static config facts above. No query text in the log (house rule).
		logger.warn("[rag] query embedding failed — this turn skips local grounding");
		return [];
	}
	if (qv.length !== index.dim) {
		logger.warn(
			{ queryDim: qv.length, indexDim: index.dim },
			"[rag] query embedding dimension does not match the index — this turn skips local grounding"
		);
		return [];
	}
	// The authored corpus and the catalog entities each get their own top-K (CUR-2429). Ranked as one
	// pool, ~1,800 entity chunks would fill all five slots for "Who runs Current AI?", the entity-scope
	// guard would drop all five, and the about-us chunk that answers it would never reach the reranker. The reranker orders the merged list, so at most 2×K candidates
	// reach it.
	const entities = await loadEntityChunks();
	const scored = [
		...rankByCosine(qv, index.chunks, localMinScore(), localTopK()),
		...(entities.length ? rankByCosine(qv, entities, localMinScore(), localTopK()) : []),
	].sort((a, b) => b.score - a.score);

	return scored.map(({ chunk, score }) => ({
		title: chunk.title,
		url: chunk.url,
		// Authored corpus: show the whole chunk (CURATED_SNIPPET_CAP), minus the synonym tail the build
		// appends for embedding recall. The 480 default is the federated defense and does not belong
		// here — it would truncate committed chunks mid-sentence (see parseDoc.ts).
		snippet: toSnippet(stripRecallTail(chunk.text), CURATED_SNIPPET_CAP),
		engine: "Potluck" as const,
		score,
	}));
}

/** Whether the committed index actually has content (gates the local store). */
export function localStoreReady(): boolean {
	return (index.chunks?.length ?? 0) > 0;
}

export type LocalCatalogChunk = {
	id: string;
	source: string;
	title: string;
	url?: string;
	text: string;
};
export type LocalCatalog = {
	model: string;
	dim: number;
	builtAt: string;
	/** True only when the index is non-empty AND was embedded with the active model — i.e. it's
	 * actually being served (mirrors queryLocalStore's identity guard). False means the chunks
	 * below are stale and silently skipped at query time until the index is rebuilt. */
	served: boolean;
	chunks: LocalCatalogChunk[];
};

/**
 * Read-only view of the committed Tier-A chunks (vectors stripped) for the admin console. The
 * catalog is built offline (scripts/build-rag-index.mjs) and served from a static import, so it
 * can't be edited here — this just makes the gap-map categories/exemplars/stack-map visible
 * alongside the editable DB store.
 */
export function listLocalCatalog(): LocalCatalog {
	const chunks: LocalCatalogChunk[] = (index.chunks ?? []).map(
		({ id, source, title, url, text }) => ({
			id,
			source,
			title,
			url,
			text,
		})
	);
	return {
		model: index.model,
		dim: index.dim,
		builtAt: index.builtAt,
		served: localStoreReady() && index.model === embeddingModel(),
		chunks,
	};
}

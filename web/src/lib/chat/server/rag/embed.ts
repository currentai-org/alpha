// Single-string embedding via the HF Inference feature-extraction endpoint.
// The HF router (OPENAI_BASE_URL, /v1) does NOT expose /embeddings, so the local
// store embeds through {base}/{model}/pipeline/feature-extraction, which returns
// a flat number[] for one input. Best-effort: any failure returns null and the
// caller (the local RAG store) skips grounding rather than breaking the turn.
//
// The build script (scripts/build-rag-index.mjs) intentionally duplicates this
// tiny fetch — it runs in plain Node and cannot import this TS module — so keep
// the request shape in the two files in sync.

import {
	embeddingBaseUrl,
	embeddingBillTo,
	embeddingEndpointUrl,
	embeddingModel,
	embeddingToken,
	MULTILINGUAL_EMBEDDING_MODEL,
	multilingualEmbeddingEndpointUrl,
} from "./env";
import { logger } from "$lib/chat/server/logger";
import { replayAwareFetch } from "$lib/chat/server/openaiClient";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { queryEmbedCache, EmbedCache } from "./embedCache";

/** The feature-extraction URL for `model`. Each dedicated endpoint serves one model: the RAG embedder's,
 *  or the self-identity check's. Any other model, or one whose endpoint is unset, goes through the
 *  shared serverless path. */
function featureExtractionUrl(model: string): string {
	const dedicated =
		model === embeddingModel()
			? embeddingEndpointUrl()
			: model === MULTILINGUAL_EMBEDDING_MODEL
				? multilingualEmbeddingEndpointUrl()
				: "";
	return dedicated || `${embeddingBaseUrl()}/${model}/pipeline/feature-extraction`;
}

/** `model` defaults to the RAG embedder. A caller that fitted a threshold in another model's space
 *  (selfIdentity.ts) names that model here, so a change to the RAG embedder cannot move its margins. */
export async function embedText(
	text: string,
	timeoutMs = 6000,
	model: string = embeddingModel()
): Promise<number[] | null> {
	const input = text.trim();
	if (!input) {
		return null;
	}
	// Query embeddings are a pure function of (model, text) — serve a memoized vector when we have one,
	// skipping the HF round-trip entirely (the per-turn latency in the local catalog path). Only successful results
	// are cached below, so a transient failure never poisons the cache. Keyed by the model, so a
	// model swap can't return a stale, non-comparable vector.
	const cacheKey = EmbedCache.key(model, input);
	const cached = queryEmbedCache.get(cacheKey);
	if (cached) {
		return cached;
	}
	const url = featureExtractionUrl(model);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const billTo = embeddingBillTo();
		const res = await replayAwareFetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${embeddingToken()}`,
				// Bill inference to the configured HF org (X-HF-Bill-To) when set — mirrors the chat
				// endpoints' per-user billing, but server-side embeddings have no user, so it's env-driven.
				...(billTo ? { "X-HF-Bill-To": billTo } : {}),
			},
			body: JSON.stringify({ inputs: input }),
			signal: ac.signal,
		}, { liveOnMiss: true });
		if (!res.ok) {
			logger.warn({ status: res.status }, "[rag] embedding endpoint non-OK; skipping local store");
			failOpenDeparture("embed", "non-ok", { status: res.status });
			return null;
		}
		const json = (await res.json()) as unknown;
		// A single string yields number[]; some models nest it as number[][].
		let vec: number[] | null = null;
		if (Array.isArray(json) && typeof json[0] === "number") {
			vec = json as number[];
		} else if (Array.isArray(json) && Array.isArray(json[0])) {
			vec = json[0] as number[];
		}
		if (vec) {
			queryEmbedCache.set(cacheKey, vec);
			return vec;
		}
		logger.warn("[rag] unexpected embedding shape; skipping local store");
		failOpenDeparture("embed", "unexpected-shape");
		return null;
	} catch (e) {
		logger.warn(e, "[rag] embedding failed; skipping local store");
		failOpenDeparture("embed", ac.signal.aborted ? "timeout" : "error");
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** The most inputs one request carries. A dedicated endpoint runs TEI, which refuses more:
 *  "batch size 58 > maximum allowed batch size 32" (HTTP 422). */
const MAX_BATCH = 32;

/**
 * Batch feature-extraction: embed MANY strings in ONE request. The HF pipeline accepts an array of
 * inputs and returns one sentence vector per input (N×dim), so write-time embedding doesn't have to
 * fire one HTTP call per chunk (the sequential loop that risked the serverless timeout). Returns null
 * on any non-OK response, unexpected shape, or a count mismatch — callers treat null as "embedding
 * failed" and fail-closed (nothing is persisted), so a partial/garbled batch can't corrupt the store.
 */
export async function embedTexts(
	texts: string[],
	timeoutMs = 15000,
	model: string = embeddingModel()
): Promise<number[][] | null> {
	const inputs = texts.map((t) => t.trim());
	if (inputs.length === 0 || inputs.some((t) => !t)) {
		return null;
	}
	if (inputs.length > MAX_BATCH) {
		const parts = await Promise.all(
			Array.from({ length: Math.ceil(inputs.length / MAX_BATCH) }, (_, i) =>
				embedTexts(inputs.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH), timeoutMs, model)
			)
		);
		return parts.some((p) => p === null) ? null : parts.flat() as number[][];
	}
	const url = featureExtractionUrl(model);
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const billTo = embeddingBillTo();
		const res = await replayAwareFetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${embeddingToken()}`,
				...(billTo ? { "X-HF-Bill-To": billTo } : {}),
			},
			body: JSON.stringify({ inputs }),
			signal: ac.signal,
		}, { liveOnMiss: true });
		if (!res.ok) {
			logger.warn(
				{ status: res.status, n: inputs.length },
				"[rag] batch embedding endpoint non-OK; skipping local store"
			);
			return null;
		}
		const json = (await res.json()) as unknown;
		// One sentence vector per input: a length-N array of number[] (N×dim).
		if (
			Array.isArray(json) &&
			json.length === inputs.length &&
			Array.isArray(json[0]) &&
			typeof (json[0] as unknown[])[0] === "number"
		) {
			return json as number[][];
		}
		logger.warn("[rag] unexpected batch embedding shape; skipping local store");
		return null;
	} catch (e) {
		logger.warn(e, "[rag] batch embedding failed; skipping local store");
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Cosine similarity for two equal-length vectors. Returns 0 on degenerate input. */
export function cosine(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		return 0;
	}
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	if (na === 0 || nb === 0) {
		return 0;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Highest cosine between `query` and any vector in `set`. -1 for an empty set, so an empty side can
 *  never win a comparison against a populated one. Shared by the two-sided exemplar gates
 *  (search/searchIntent.ts, selfIdentity.ts). */
export function maxCosine(query: readonly number[], set: readonly (readonly number[])[]): number {
	let best = -1;
	for (const v of set) {
		const s = cosine(query as number[], v as number[]);
		if (s > best) best = s;
	}
	return best;
}

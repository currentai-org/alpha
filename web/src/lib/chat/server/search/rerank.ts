// Cross-encoder reranking of open-search candidates by true query-relevance, using an OPEN reranker
// (BGE, BAAI/bge-reranker-v2-m3). BM25/keyword retrieval ranks off-topic pages high; a cross-encoder
// scores (query, doc) jointly and reorders — off-topic docs score ~0, so a small threshold drops them.
// No closed vendor: the reranker is an open model on the stack.
//
// THREE transports, one pure core (applyRerank). A dedicated TEI endpoint (RERANK_ENDPOINT_URL) wins;
// otherwise RERANK_KIND selects:
//   • "cohere" (default) — POST {RERANK_BASE_URL|OPENAI_BASE_URL}/rerank, Cohere-shaped
//     {model,query,documents} → {results:[{index,relevance_score}]}. This is the CSCS sovereign
//     endpoint (production OPENAI_BASE_URL serves /v1/rerank natively) — unchanged behavior.
//   • "hf" — the HF serverless lane. The HF router exposes NO /rerank route, but bge-reranker-v2-m3
//     is a num_labels=1 cross-encoder reachable via the text-classification TASK: score each
//     (query</s></s>doc) PAIR in ONE batched call to hf-inference/models/{model}. Needs an HF token
//     + X-HF-Bill-To (same plumbing as the injection classifier and RAG embeddings). This is what
//     lets the HF-router deployment AND local dev actually rerank (the CSCS /rerank isn't reachable
//     there). Measured score distribution matches CSCS (direct ~0.97+, off-topic ~0.0002).
//   • "tei" — a dedicated WARM text-embeddings-inference endpoint's native /rerank (RERANK_ENDPOINT_URL),
//     a warm endpoint that avoids the cold-start aborts of a serverless lane. See rerankTei.
//
// Gated on RERANK_MODEL (empty = off) so it's prod-safe. Best-effort with a SPLIT failure policy: the
// grounding gate path (allowEmpty) FAILS CLOSED to [] on any error/unverified response — an unvetted
// source must never be presented as grounded; ordering-only callers keep the input order. Both carry a
// `verified` flag so the caller knows which happened (see rerankByRelevance).

import { config } from "$lib/chat/server/config";
import { logger } from "$lib/chat/server/logger";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { firstKey } from "$lib/chat/server/env/firstKey";
import { noteOverridden } from "$lib/chat/server/env/overridden";
import { hfBillToHeader } from "$lib/chat/server/hfBillTo";
import { replayAwareFetch } from "$lib/chat/server/openaiClient";

/** Reflect.get reader for non-committed config keys: they aren't in committed .env, so the
 *  SvelteKit-generated $env type omits them where unset (CI), and direct access fails svelte-check.
 *  Same pattern as MODELS / MODEL_ALLOWLIST and rag/env.ts. */
function readKey(key: string): string {
	return ((Reflect.get(config, key) as string | undefined) || "").trim();
}

/** Configured reranker model id (e.g. "BAAI/bge-reranker-v2-m3"); "" = disabled. */
export function rerankModel(): string {
	return readKey("RERANK_MODEL");
}

let warnedRerankNoModel = false;
/** Whether reranking is active. RERANK_MODEL is the master gate; RERANK_KIND only picks the transport
 *  and is a NO-OP on its own. Setting KIND but not MODEL silently leaves rerank OFF (search returns
 *  retrieval order, off-topic hits included) — a misconfiguration worth a warning, logged
 *  once. */
export function rerankEnabled(): boolean {
	const model = rerankModel();
	if (!model && readKey("RERANK_KIND") && !warnedRerankNoModel) {
		warnedRerankNoModel = true;
		logger.warn(
			"[rerank] RERANK_KIND is set but RERANK_MODEL is empty — reranking is OFF (search returns retrieval order). Set RERANK_MODEL (e.g. BAAI/bge-reranker-v2-m3) to enable it."
		);
	}
	return !!model;
}

/** A dedicated warm TEI /rerank endpoint (text-embeddings-inference on an HF Inference Endpoint). When
 *  set, it OVERRIDES RERANK_KIND and selects the native /rerank transport — it avoids the cold HF
 *  serverless lane, where the default 3s timeout aborts on a cold model load and reranking
 *  falls back to retrieval order. The endpoint is model-fixed, so RERANK_MODEL stays only the
 *  on/off gate, never a path component. Trailing slash trimmed. */
function rerankEndpointUrl(): string {
	return readKey("RERANK_ENDPOINT_URL").replace(/\/+$/, "");
}

/** Max documents per /rerank call. TEI enforces max_client_batch_size (32 on our endpoint) and 422s a
 *  larger batch. The wide net is right-sized to ≤32 so this is a SINGLE call in normal operation; a net
 *  that ever exceeds it is chunked (see rerankByRelevance) rather than 422'd. */
function rerankMaxBatch(): number {
	const n = Number(readKey("RERANK_MAX_BATCH"));
	return Number.isInteger(n) && n > 0 ? n : 32;
}

/** Transport selector. A dedicated TEI endpoint wins (implicit "tei" — Decision C); otherwise
 *  RERANK_KIND picks "hf" vs the default "cohere" (CSCS sovereign /rerank, byte-for-byte unchanged). */
function rerankKind(): "cohere" | "hf" | "tei" {
	if (rerankEndpointUrl()) {
		// RERANK_KIND is never consulted on this path. A deployment with it set to "hf" while running
		// TEI would otherwise get no signal (CUR-112), hence the announcement, which stays silent
		// unless the losing key is actually set.
		noteOverridden("rerank.transport", "tei", "RERANK_ENDPOINT_URL", [
			["RERANK_KIND", readKey("RERANK_KIND")],
		]);
		return "tei";
	}
	return readKey("RERANK_KIND").toLowerCase() === "hf" ? "hf" : "cohere";
}

type RerankResult = { index: number; relevance_score: number };

/**
 * Pure: turn the /v1/rerank response into a reordered subset of the original
 * candidates. Sorted by relevance (the API already sorts), dropping anything
 * below `minScore` and keeping at most `topK`. Indices that don't map to a real
 * candidate are skipped. Exported for unit testing without a network call.
 */
export function applyRerank<T>(
	candidates: T[],
	results: RerankResult[] | undefined,
	opts: {
		topK?: number;
		minScore?: number;
		allowEmpty?: boolean;
		// #2 relative floor: after the absolute floor, drop survivors whose raw score is more than a
		// factor below the top — but ONLY when a confident anchor exists (top ≥ minTop). Absent → no-op.
		relativeFloor?: { ratio: number; minTop: number };
		// #4 trust/recency prior: a small additive adjustment applied to SURVIVORS ONLY (after both
		// floors), so it reorders the admitted set but can never re-admit a below-floor page. Absent → no-op.
		scoreAdjust?: (candidate: T, rawScore: number) => number;
	} = {}
): T[] {
	if (!results?.length) {
		return candidates;
	}
	const {
		topK = candidates.length,
		minScore = 0,
		allowEmpty = false,
		relativeFloor,
		scoreAdjust,
	} = opts;
	// Pipeline (see #2/#4): (1) sort by RAW score desc, (2) absolute floor + valid index.
	let survivors = [...results]
		.sort((a, b) => b.relevance_score - a.relevance_score)
		.filter((r) => r.relevance_score >= minScore && candidates[r.index] !== undefined);
	// (3) relative floor: survivors is sorted desc, so survivors[0] is the top. Engage only when the top
	// clears minTop (a confident anchor); drop the weak tail below top*ratio. The `i === 0` guard ALWAYS
	// keeps the anchor, so a non-empty set can NEVER empty here — structurally, even if a misconfigured
	// ratio > 1 were passed (openSearch also clamps ratio to (0,1], but this keeps the invariant local).
	if (relativeFloor && survivors.length) {
		const top = survivors[0].relevance_score;
		if (top >= relativeFloor.minTop) {
			const cutoff = top * relativeFloor.ratio;
			survivors = survivors.filter((r, i) => i === 0 || r.relevance_score >= cutoff);
		}
	}
	// (4) scoreAdjust on survivors ONLY, then re-sort by the adjusted score. Strictly after the floors, so
	// a prior can reorder the admitted top-K but never lift a below-floor candidate back in.
	if (scoreAdjust) {
		survivors = survivors
			.map((r) => ({
				r,
				adj: r.relevance_score + scoreAdjust(candidates[r.index], r.relevance_score),
			}))
			.sort((a, b) => b.adj - a.adj)
			.map((x) => x.r);
	}
	// (5) topK, (6) map to candidates.
	const ranked = survivors.slice(0, topK).map((r) => candidates[r.index]);
	// `allowEmpty` (the grounding-relevance gate): returning [] is the POINT. If nothing
	// clears the floor, every retrieved source is off-topic, and presenting them as
	// citations would be a fabricated "grounded" look (the model attaches [n] to training
	// claims). Empty → the turn answers honestly ungrounded, with no fake citations.
	if (ranked.length === 0 && allowEmpty) {
		return [];
	}
	// Default (allowEmpty off): never return empty when we started with candidates — if the
	// threshold nuked everything, fall back to the single best-ranked candidate (some
	// grounding beats none for ordering-only callers).
	if (ranked.length === 0) {
		const best = [...results].sort((a, b) => b.relevance_score - a.relevance_score)[0];
		return candidates[best.index] !== undefined ? [candidates[best.index]] : candidates;
	}
	return ranked;
}

/**
 * Deep-flatten an hf-inference text-classification response into one score per input, IN ORDER.
 * The serverless batch response nests as `[[{label,score}, …]]` (a single inner list, N items, in
 * input order); a non-batched response is the flat `[{label,score}]`. Both reduce to the leaf
 * {label,score} objects in order, so a depth-first walk collecting every numeric `score` recovers
 * the per-input scores regardless of the wrapper nesting. Exported for unit testing.
 */
export function flattenClassificationScores(data: unknown): number[] {
	const out: number[] = [];
	const walk = (x: unknown): void => {
		if (Array.isArray(x)) {
			x.forEach(walk);
		} else if (x && typeof x === "object" && typeof (x as { score?: unknown }).score === "number") {
			out.push((x as { score: number }).score);
		}
	};
	walk(data);
	return out;
}

/** Cohere-shaped /rerank transport (CSCS sovereign endpoint). Returns null on transport failure. */
async function rerankCohere(
	model: string,
	query: string,
	documents: string[],
	key: string,
	signal: AbortSignal
): Promise<RerankResult[] | null> {
	const base = (readKey("RERANK_BASE_URL") || config.OPENAI_BASE_URL || "").replace(/\/$/, "");
	// Not an override in the same sense (OPENAI_BASE_URL is the documented fallback), so this only
	// speaks when BOTH are set and the general one is therefore unused for reranking.
	if (readKey("RERANK_BASE_URL")) {
		noteOverridden("rerank.cohere.baseUrl", base, "RERANK_BASE_URL", [
			["OPENAI_BASE_URL", config.OPENAI_BASE_URL],
		]);
	}
	const res = await replayAwareFetch(`${base}/rerank`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({ model, query, documents }),
		signal,
	}, { liveOnMiss: true });
	if (!res.ok) {
		logger.warn({ engine: "rerank-cohere", status: res.status }, "[rerank] cohere non-OK; keeping retrieval order");
		return null;
	}
	const json = (await res.json()) as { results?: RerankResult[] };
	return json.results ?? [];
}

/** HF text-classification transport: ONE batched call scoring (query</s></s>doc) pair-strings.
 *  Mirrors the injection classifier's auth/bill-to plumbing (moderation.ts). null on failure. */
async function rerankHf(
	model: string,
	query: string,
	documents: string[],
	key: string,
	signal: AbortSignal
): Promise<RerankResult[] | null> {
	const base = (readKey("RERANK_HF_BASE_URL") || "https://router.huggingface.co").replace(
		/\/+$/,
		""
	);
	const billTo = readKey("RERANK_BILL_TO") || readKey("HF_BILL_TO");
	if (readKey("RERANK_BILL_TO")) {
		noteOverridden("rerank.hf.billTo", billTo, "RERANK_BILL_TO", [
			["HF_BILL_TO", readKey("HF_BILL_TO")],
		]);
	}
	// </s></s> is the XLM-RoBERTa pair separator; the cross-encoder reads it as the (query, passage)
	// pair and emits a single relevance logit → sigmoid score. Validated against the live endpoint.
	const inputs = documents.map((d) => `${query}</s></s>${d}`);
	const res = await replayAwareFetch(`${base}/hf-inference/models/${model}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
			// Bill inference to the configured HF org (a user token without its own Inference-Providers
			// access 403s; billing to an org that has it makes the call work). Same as RAG embeddings.
			...hfBillToHeader(base, { ownLane: false }, billTo),
		},
		body: JSON.stringify({ inputs }),
		signal,
	}, { liveOnMiss: true });
	if (!res.ok) {
		logger.warn({ engine: "rerank-hf", status: res.status }, "[rerank] hf non-OK; keeping retrieval order");
		return null;
	}
	const scores = flattenClassificationScores(await res.json());
	// One score per input, index-aligned. A count mismatch means we can't trust the mapping — bail to
	// retrieval order rather than score the wrong (query, doc) pairs.
	if (scores.length !== documents.length) {
		logger.warn(
			{ got: scores.length, expected: documents.length },
			"[rerank] hf score count mismatch; keeping retrieval order"
		);
		return null;
	}
	return scores.map((relevance_score, index) => ({ index, relevance_score }));
}

/** Dedicated TEI /rerank transport — a warm text-embeddings-inference HF Inference Endpoint exposing the
 *  native reranker route. TEI returns a BARE `[{index, score}]` array sorted desc (a THIRD wire shape,
 *  distinct from Cohere's `{results:[{index,relevance_score}]}` and the HF text-classification
 *  pair-scores). Called directly (the endpoint is model-fixed); NO X-HF-Bill-To — dedicated compute is
 *  billed by the endpoint itself. null on transport failure; a non-array 200 → [] so the caller fails
 *  closed (unverified) rather than mis-mapping. */
async function rerankTei(
	query: string,
	documents: string[],
	key: string,
	signal: AbortSignal
): Promise<RerankResult[] | null> {
	const url = rerankEndpointUrl();
	const res = await replayAwareFetch(`${url}/rerank`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		// raw_scores:false → sigmoid-normalized relevance in [0,1], comparable to the Cohere/HF floors.
		body: JSON.stringify({ query, texts: documents, raw_scores: false }),
		signal,
	}, { liveOnMiss: true });
	if (!res.ok) {
		logger.warn({ engine: "rerank-tei", status: res.status }, "[rerank] tei non-OK; unverified");
		return null;
	}
	const json = (await res.json()) as unknown;
	if (!Array.isArray(json)) return [];
	// Map TEI's {index,score} → our {index,relevance_score}. Missing/typed-wrong fields become an
	// out-of-range index / NaN score, which normalizeResults then drops (→ [] → fail-closed unverified).
	return json.map((entry) => {
		const r = (entry ?? {}) as { index?: number; score?: number };
		return {
			index: typeof r.index === "number" ? r.index : -1,
			relevance_score: typeof r.score === "number" ? r.score : Number.NaN,
		};
	});
}

/** Validate that a reranker response gives FULL, UNIQUE coverage: exactly one well-formed score
 *  (integer index in 0..n-1, each index once, finite score) for EVERY submitted document. Anything
 *  else — a short/partial response, an over-long one, a duplicate or out-of-range index, a NaN score,
 *  an empty `[]`, or a null transport failure — means some candidate was never vetted, so we CANNOT
 *  claim relevance was verified: return null and the caller fails CLOSED (unverified). This is what
 *  stops a partial 200 (e.g. one score for 32 docs) from grounding source 0 on the strength of the
 *  other 31 never being scored. rerankHf already count-guards internally; this extends the same
 *  guarantee to the cohere/TEI transports AND to each merged chunk. */
function normalizeResults(results: RerankResult[] | null, n: number): RerankResult[] | null {
	if (!results || results.length !== n) return null;
	const seen = new Set<number>();
	for (const r of results) {
		if (
			!Number.isInteger(r.index) ||
			r.index < 0 ||
			r.index >= n ||
			seen.has(r.index) ||
			!Number.isFinite(r.relevance_score)
		) {
			return null;
		}
		seen.add(r.index);
	}
	return results;
}

/** Rerank a wide net that exceeds the transport's batch ceiling by splitting it into ≤maxBatch chunks,
 *  scoring them CONCURRENTLY under the caller's single rerank deadline (the shared AbortSignal), and
 *  merging. Scores are comparable across chunks (same model + query), so one applyRerank over the merged
 *  set ranks correctly. Fail-closed: each chunk is validated with normalizeResults against its OWN size
 *  (full, unique coverage of 0..chunkLen-1); a null / short / duplicate / out-of-local-range chunk
 *  collapses the WHOLE rerank to null → unverified. Each chunk's validated local index is then offset into
 *  the global candidate array before merge. In normal operation the wide net is right-sized to ≤maxBatch
 *  so this never runs; it's the safety valve for drift. */
async function rerankChunked(
	call: (docs: string[]) => Promise<RerankResult[] | null>,
	documents: string[],
	maxBatch: number
): Promise<RerankResult[] | null> {
	const chunks: string[][] = [];
	for (let i = 0; i < documents.length; i += maxBatch) {
		chunks.push(documents.slice(i, i + maxBatch));
	}
	const settled = await Promise.all(chunks.map((c) => call(c)));
	const merged: RerankResult[] = [];
	for (let ci = 0; ci < chunks.length; ci++) {
		// Validate each chunk against ITS OWN size (full, unique coverage of 0..chunkLen-1) BEFORE
		// offsetting — a null / short / duplicate / out-of-local-range chunk means its index→doc mapping
		// can't be trusted, so the merged set would silently mis-rank or under-rank a doc. Fail the whole
		// rerank closed rather than ground on a partial or corrupt set.
		const chunkResults = normalizeResults(settled[ci], chunks[ci].length);
		if (!chunkResults) return null;
		const offset = ci * maxBatch;
		for (const r of chunkResults) {
			merged.push({ index: r.index + offset, relevance_score: r.relevance_score });
		}
	}
	return merged;
}

/**
 * Reorder candidates by cross-encoder relevance to the query, AND report whether relevance was actually
 * VERIFIED. `verified` is true IFF a real reranker result was scored and applied (including a
 * deliberately-empty all-below-floor result — that's a verified "nothing relevant"). It is false on
 * every fail-closed path: reranker disabled, no candidates, transport null/[]/malformed-200, timeout, or
 * throw. The caller uses `verified` as the grounding gate — an UNVERIFIED rerank must never be presented
 * as grounded (a reranker that aborts must not leave raw retrieval order cited as if vetted).
 *
 * Fail-closed shape: on the gate path (opts.allowEmpty) an unverified result is `items: []` — the turn
 * answers ungrounded — NOT the raw retrieval order. Ordering-only callers (allowEmpty off) still get the
 * candidates back so search never breaks for them. Each candidate is scored on its title + snippet.
 */
export async function rerankByRelevance<
	T extends { title: string; snippet: string; rerankText?: string },
>(
	query: string,
	candidates: T[],
	opts: {
		topK?: number;
		minScore?: number;
		timeoutMs?: number;
		allowEmpty?: boolean;
		// #2/#4 (opt-in; the SHARED RAG + SyftHub callers pass neither, so their behavior is unchanged).
		relativeFloor?: { ratio: number; minTop: number };
		scoreAdjust?: (candidate: T, rawScore: number) => number;
	} = {}
): Promise<{ items: T[]; verified: boolean }> {
	const unverified = { items: opts.allowEmpty ? [] : candidates, verified: false };
	const model = rerankModel();
	// Disabled, or nothing to score → unverified. (The single-candidate short-circuit is GONE: a lone
	// candidate is now scored against the floor like any other, so one off-topic hit can't ride through
	// as "grounded" merely because it was alone.)
	if (!model || candidates.length === 0) {
		return unverified;
	}
	const kind = rerankKind();
	// TEI prefers a dedicated endpoint token; the HF path is HF-token-first (it bills HF inference); the
	// Cohere/CSCS path is OPENAI-key-first. Each falls back so a single configured key still works.
	const key =
		kind === "tei"
			? firstKey(
					["RERANK_ENDPOINT_TOKEN", "RERANK_HF_TOKEN", "HF_RAG_EMBEDDINGS_TOKEN", "HF_TOKEN"],
					"rerankTeiToken"
				)
			: kind === "hf"
				? // OPENAI_API_KEY tail is the same last-resort fallback as embeddingToken
					// (rag/env.ts) — HF-named tokens first because this path bills HF inference, and
					// OPENAI_API_KEY only matters where it is itself an HF key.
					firstKey(["RERANK_HF_TOKEN", "HF_TOKEN", "OPENAI_API_KEY"], "rerankHfToken")
				: firstKey(["OPENAI_API_KEY", "HF_TOKEN"], "rerankCohereToken");
	// Score the reranker-only `rerankText` when a candidate carries one (richer document for
	// metadata-thin engines like HF/OpenAlex — #3), else the model-facing title + snippet. Capped at
	// 1200 either way; rerankText never reaches the wire type (it's built server-local by openSearch).
	const documents = candidates.map((c) =>
		(c.rerankText ?? `${c.title}\n${c.snippet}`).slice(0, 1200)
	);
	// Own timeout — NOT the caller's retrieval budget. Reranking runs after the engines, so sharing their
	// (often nearly-spent) abort signal starved the call and silently degraded to retrieval order. A warm
	// dedicated endpoint makes the raised default (the caller passes ~6000ms) safe.
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
	// One transport call for a batch of documents (the whole set, or one chunk of it).
	const call = (docs: string[]): Promise<RerankResult[] | null> =>
		kind === "tei"
			? rerankTei(query, docs, key, ac.signal)
			: kind === "hf"
				? rerankHf(model, query, docs, key, ac.signal)
				: rerankCohere(model, query, docs, key, ac.signal);
	try {
		const maxBatch = rerankMaxBatch();
		const raw =
			documents.length <= maxBatch
				? await call(documents)
				: await rerankChunked(call, documents, maxBatch);
		const results = normalizeResults(raw, documents.length);
		// Fail CLOSED: transport null / [] / malformed-200 (all collapse to null-or-empty here) means we
		// could not verify relevance → unverified. The turn answers ungrounded, not citing unvetted junk.
		if (!results || results.length === 0) {
			failOpenDeparture("rerank", "no-usable-result", { kind, candidates: candidates.length });
			return unverified;
		}
		// A real reranker result was produced and applied — relevance is VERIFIED. applyRerank may still
		// return [] on the gate path (everything below the floor); that is a verified "nothing relevant".
		return { items: applyRerank(candidates, results, opts), verified: true };
	} catch (e) {
		// Read before the abort below, which would otherwise make every throw look like a timeout.
		const timedOut = ac.signal.aborted;
		// Abort any still-in-flight requests before returning: a rejected Promise.all in the chunker
		// leaves its sibling chunk fetches running, and on a single-call throw this is a harmless no-op —
		// either way, don't let orphaned requests outlive the failed rerank.
		ac.abort();
		logger.warn(e, "[rerank] failed; unverified (retrieval order only off the gate path)");
		failOpenDeparture("rerank", timedOut ? "timeout" : "error", {
			kind,
			candidates: candidates.length,
		});
		return unverified;
	} finally {
		clearTimeout(timer);
	}
}

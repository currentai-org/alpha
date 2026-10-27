// Centralized reads for the RAG-store config keys. They are deploy-only and not
// in the committed .env, so we go through Reflect.get on the config proxy to
// avoid the ConfigProxy typecheck error on unset keys (same pattern as
// RERANK_MODEL). All federated paths are additive and gated:
// no token, no index, or any failure must fail open to a normal answer.

import { config } from "$lib/chat/server/config";
import { firstKey } from "$lib/chat/server/env/firstKey";

function read(key: string): string {
	return ((Reflect.get(config, key) as string | undefined) || "").trim();
}

function readNumber(key: string, fallback: number): number {
	const n = Number(read(key));
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Like readNumber but accepts 0 and negatives — for score thresholds where 0 (accept all)
// is a meaningful value, unlike counts/timeouts which must be positive. Guards the unset case
// explicitly: Number("") is 0 (a finite value), so an empty key must fall back, not read as 0.
function readFloat(key: string, fallback: number): number {
	const raw = read(key);
	if (!raw) {
		return fallback;
	}
	const n = Number(raw);
	return Number.isFinite(n) ? n : fallback;
}

/** Master gate for all RAG grounding (local + federated). */
export function ragEnabled(): boolean {
	return read("RAG_ENABLED") === "true";
}

/** Embedding model id for the local Tier-A store (must match the built index). */
export function embeddingModel(): string {
	return read("RAG_EMBEDDING_MODEL") || "sentence-transformers/all-MiniLM-L6-v2";
}

/** HF Inference feature-extraction base (the HF router /v1 has no /embeddings). */
export function embeddingBaseUrl(): string {
	return (
		read("RAG_EMBEDDING_BASE_URL") || "https://router.huggingface.co/hf-inference/models"
	).replace(/\/$/, "");
}

/** A DEDICATED HF Inference Endpoint URL for the embeddings model (always-warm, no scale-to-zero —
 *  the fix for the embeddings cold-start). When set, it's called DIRECTLY (the model is fixed to the
 *  endpoint, so there's no `…/{model}/pipeline/feature-extraction` path like the shared serverless
 *  router); empty ⇒ fall back to the serverless base above. Same `{inputs: …}` body + token. */
export function embeddingEndpointUrl(): string {
	return read("RAG_EMBEDDING_ENDPOINT_URL").replace(/\/$/, "");
}

/** The multilingual sentence embedder. Fixed, not configured: a caller's threshold is fitted in this
 *  model's space, so changing it moves every margin. The self-identity check (selfIdentity.ts) uses it. */
export const MULTILINGUAL_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

/** A dedicated always-warm endpoint serving MULTILINGUAL_EMBEDDING_MODEL. HF's shared serverless queue
 *  for this model can take 7–21 s a call under load, past the identity check's 6 s budget (CUR-2135);
 *  empty ⇒ the serverless path, which still works when the queue is short. */
export function multilingualEmbeddingEndpointUrl(): string {
	return read("MULTILINGUAL_EMBEDDING_ENDPOINT_URL").replace(/\/$/, "");
}

/** Bearer token for RAG HF inference (the feature-extraction embeddings AND the image-caption
 *  ingestion call). Prefers a DEDICATED RAG token (HF_RAG_EMBEDDINGS_TOKEN) so RAG inference can be
 *  keyed and billed separately from the chat path; falls back to the shared inference key
 *  (OPENAI_API_KEY → HF_TOKEN) when it is unset. */
export function embeddingToken(): string {
	// firstKey logs (once) if it falls past the dedicated token or comes up empty — so a silent
	// "no token / wrong token → 401" failure can't hide behind a generic auth error.
	// HF-named tokens FIRST: the embed endpoint is HF feature-extraction (needs an hf_… token). When the chat
	// lane is CSCS, OPENAI_API_KEY is the CSCS sk-… chat key — NOT valid for HF — so it goes LAST
	// (only useful where it is itself the HF key). firstKey logs whichever it lands on.
	// The second-opinion key is not in the chain: it belongs to the compare panel (CUR-2265).
	return firstKey(
		["HF_RAG_EMBEDDINGS_TOKEN", "HF_TOKEN", "OPENAI_API_KEY"],
		"embeddingToken"
	);
}

/** Org to bill embedding inference to (X-HF-Bill-To). A user token without its own
 * Inference-Providers access 403s; billing to an org that has it (e.g. current-ai-official)
 * makes the call work. RAG_EMBEDDING_BILL_TO overrides; falls back to HF_BILL_TO. Empty ⇒ the
 * header is omitted (no-op). Keep in sync with build-rag-index.mjs (BILL_TO). */
export function embeddingBillTo(): string {
	// RAG_EMBEDDING_BILL_TO is an override, so landing on HF_BILL_TO is the designed path, not a
	// misconfiguration — optionalPreferred keeps it out of the warn stream (see firstKey).
	return firstKey(["RAG_EMBEDDING_BILL_TO", "HF_BILL_TO"], "embeddingBillTo", {
		allowEmpty: true,
		optionalPreferred: true,
	});
}

export function localTopK(): number {
	return readNumber("RAG_TOP_K", 5);
}

export function localMinScore(): number {
	const n = Number(read("RAG_MIN_SCORE"));
	return Number.isFinite(n) ? n : 0.35;
}

/** Cross-encoder relevance floor for the RAG rerank gate — applied by rerankRagHits over the merged RAG
 *  hits using the SAME open BGE reranker (RERANK_MODEL) the open-web search path uses. Mirrors
 *  openSearch's GROUND_RELEVANCE_FLOOR (0.02): BGE scores are sharply bimodal (on-topic ~0.99, off-topic
 *  ~0.0002), so a low floor drops the cosine false-positives that clear RAG_MIN_SCORE but aren't truly
 *  on-topic (the recency-window mis-citation class) without risking a real partial match. Only takes
 *  effect when the reranker is enabled AND verifies; a failed/disabled reranker degrades to the
 *  cosine/similarity floor (see rerankRagHits). Accepts 0 (accept-all) via readFloat. */
export function ragRerankMinScore(): number {
	return readFloat("RAG_RERANK_MIN_SCORE", 0.02);
}

/** Timeout (ms) for the RAG rerank call. Deliberately short (default 3000, the shared reranker's own
 *  default) because it STACKS after retrieval (local ≤ 8s, SyftHub ≤ 9s) and before generation AND
 *  because degrade-to-cosine is an acceptable outcome — so unlike web search (6000ms, which WANTS to ride
 *  out a cold-lane model load) RAG should FAIL FAST: a warm dedicated reranker (RERANK_ENDPOINT_URL)
 *  answers in well under 1s, and on today's cold serverless lane a short timeout caps the wasted wait
 *  before degrading rather than blocking the turn. Raise only if a warm endpoint needs more headroom. */
export function ragRerankTimeoutMs(): number {
	return readNumber("RAG_RERANK_TIMEOUT_MS", 3000);
}

/** TTFT: upstream-similarity floor BELOW which the cross-encoder rerank is skipped outright — when EVERY
 *  merged hit carries a store-reported score under this value, the hits are declared off-topic without
 *  paying the rerank round-trip (a chit-chat turn otherwise pays ~0.4s of rerank just to
 *  confirm `kept: 0`). Deliberately conservative: any hit MISSING a score, or at/above the floor, runs
 *  the full rerank as today. Cosine (bi-encoder) and BGE (cross-encoder) scales differ, so this floor is
 *  NOT ragRerankMinScore — it must be calibrated from the `bestScore` now emitted on the
 *  "[rag] relevance gate applied" / "no hits survived" logs. Default 0 = skip DISABLED (today's path). */
export function ragRerankSkipBelow(): number {
	return readFloat("RAG_RERANK_SKIP_COSINE_BELOW", 0);
}

/** Master gate for the admin-authored RAG store (the upload feature). Default OFF — when
 *  off, the admin store is skipped entirely and the per-turn path never touches its tables,
 *  so behavior is identical to before the feature shipped. */
export function ragAdminEnabled(): boolean {
	return read("RAG_ADMIN_ENABLED") === "true";
}

/** Hard cap on active admin chunks loaded into memory per instance (bounds the reload). */
export function adminMaxChunks(): number {
	return readNumber("RAG_ADMIN_MAX_CHUNKS", 2000);
}

/** Max chunks a single created/uploaded document may produce (RAG_ADMIN_MAX_CHUNKS_PER_DOC, default
 *  50). Bounds the per-write embed loop, which is SEQUENTIAL — raising this lets bigger documents
 *  through but increases write latency and risks the serverless function timeout, so raise modestly. */
export function maxChunksPerDoc(): number {
	return readNumber("RAG_ADMIN_MAX_CHUNKS_PER_DOC", 50);
}

/** Backstop TTL (ms) forcing a reload of the active admin chunks even if the watermark
 *  looks unchanged. The watermark probe is the primary invalidation; this is a floor. */
export function adminCacheTtlMs(): number {
	return readNumber("RAG_ADMIN_CACHE_TTL_MS", 60000);
}

/** Vision model id used to caption + OCR uploaded IMAGES into embeddable text (the multimodal
 *  upload path). Falls back to the router's configured multimodal model; empty ⇒ captionImage uses
 *  the default served model. Best-effort: a failed caption surfaces as a per-file upload error. */
export function ragVisionModel(): string {
	return firstKey(["RAG_VISION_MODEL", "LLM_ROUTER_MULTIMODAL_MODEL"], "ragVisionModel", {
		allowEmpty: true,
	});
}

/** SyftHub config for the Pattern-A federated-RAG path (discover → retrieve). Empty token
 *  disables the federated store entirely (fail-open). Identity is the service token (or guest
 *  mode) — `search.query` takes no per-user email, so chat users are never passed through.
 *  The token pays metered sources directly: it is injected as the aggregator's MPP `user_token`
 *  (see syftClient.getSyftClient), so no username/password login is needed.
 *  See docs/plans/syfthub-pattern-a.md. */
export function syft() {
	return {
		token: read("SYFTHUB_API_TOKEN"),
		baseUrl: read("SYFTHUB_BASE_URL") || "https://syfthub.openmined.org",
		// Discovery (client.hub.search): how many sources to consider, and the relevance floor
		// below which a source is NOT queried — the primary cost/recall knob for metered sources.
		discoveryTopK: readNumber("SYFTHUB_DISCOVERY_TOP_K", 5),
		discoveryMinScore: readFloat("SYFTHUB_DISCOVERY_MIN_SCORE", 0.4),
		// Per-call cap (ms) on the UNCANCELLABLE `hub.search` discovery probe. The SDK exposes no
		// signal/timeout on that call and swallows even its own 30s HTTP timeout into [] — so a dark
		// embeddings backend would otherwise burn the whole retrieveTimeoutMs (and orphan a 30s request).
		// Bounded here, and further clamped to ≤ half the remaining turn budget so metered retrieval
		// always keeps its share (see discoverCapMs). Only caps discovery — retrieval keeps its own leash.
		discoverTimeoutMs: readNumber("SYFTHUB_DISCOVER_TIMEOUT_MS", 3000),
		// Retrieval (client.search.query): docs per source, min doc similarity, and the SINGLE
		// deadline querySyftSources aborts on (covers discovery + retrieval; no second timer).
		retrieveTopK: readNumber("SYFTHUB_RETRIEVE_TOP_K", 5),
		similarityThreshold: readFloat("SYFTHUB_SIMILARITY_THRESHOLD", 0.5),
		retrieveTimeoutMs: readNumber("SYFTHUB_RETRIEVE_TIMEOUT_MS", 9000),
		// Unauthenticated access to policy-free endpoints (opt-in).
		guestMode: read("SYFTHUB_GUEST_MODE") === "true",
		// Short-lived discovery cache (hub.search results) keyed by query+config.
		discoveryCacheTtlMs: readNumber("SYFTHUB_DISCOVERY_CACHE_TTL_MS", 300000),
		// Optional scope filter for a SHARED hub — keep discovery to our own sources. Empty ⇒ no
		// filter (correct when the hub hosts only our sources).
		scopeTag: read("SYFTHUB_SOURCE_TAG"),
		scopeOwner: read("SYFTHUB_SOURCE_OWNER"),
		// Pre-retrieval relevance floor for discovered/routed picks: each pick's name+description is
		// scored against the query by the SAME cross-encoder that vets results (search/rerank), and
		// picks below the floor are dropped BEFORE the metered search.query — the deterministic gate
		// for "is this question about this source's collection?" (the router LLM alone is pick-happy:
		// it selects a metered source even for "capital of France"-class queries).
		// 0 ⇒ gate off. Degrades to ungated picks whenever the reranker can't verify (cold/disabled).
		// Default calibrated against the real hub catalog + BGE reranker: off-topic
		// queries score ≤ 0.0002 on every source, while an ON-topic query about a SUBTOPIC the source
		// description never mentions ("EPFL … photonics" vs the epfl-news blurb) scores ~0.08 and a
		// direct hit ~0.99. 0.01 sits two orders above the noise floor and 8x under the hard on-topic
		// case — do NOT raise it toward the result-floor scale (0.2 gates out real epfl-news queries).
		pickMinRerank: readFloat("SYFTHUB_PICK_MIN_RERANK", 0.01),
		// Kill switch for individual sources: comma-separated `owner/slug` paths excluded from BOTH
		// the router catalog and embedding discovery, so they are never queried (and never billed).
		// For sources that error every turn (e.g. an unparseable per-source status) — burning their
		// slice of the retrieval deadline buys nothing until the source is fixed upstream.
		sourceBlocklist: read("SYFTHUB_SOURCE_BLOCKLIST")
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean),
		// Pick-gate posture when the reranker CAN'T verify a pick's relevance (cold/failed/timed-out lane).
		// Today the gate degrades to ungated picks — so an unverifiable METERED pick still hits the paid
		// search.query, burning budget + real $ on a source we couldn't confirm is on-topic. This opt-in
		// makes the gate fail CLOSED for METERED picks only (free picks always kept — no grounding
		// loss there): "on" drops the unverifiable metered picks; "shadow" logs what it WOULD drop
		// without changing behavior (shadow-eval first); "off" (default) = today's ungated-all. A pick whose
		// metered status is unknown (catalog miss) counts as metered under fail-closed — don't pay for a
		// pick we can neither rerank-verify nor confirm is free. See gatePicksByRelevance (syftSources.ts).
		pickGateFailClosed: ((): "off" | "shadow" | "on" => {
			const v = read("SYFTHUB_PICK_GATE_FAILCLOSED").toLowerCase();
			return v === "on" || v === "shadow" ? v : "off";
		})(),
		// TTFT catalog PRE-gate: score the WHOLE scoped catalog against the query (same cross-encoder +
		// pickMinRerank floor as the post-router pick gate, same name+description text) BEFORE the LLM
		// router runs. Nothing clears the floor ⇒ the router, discovery, pick gate, and metered retrieve
		// are ALL skipped (~2s saved on turns where the pick gate would discard
		// the router's picks). Survivors ⇒ the router reasons over ONLY them and the redundant
		// post-router rerank is replaced by set membership. A pure reordering of the existing deterministic
		// gate — an UNVERIFIED pre-score (cold reranker) falls back to today's full path, so behavior can
		// only change on a VERIFIED score. Default ON; "off" is the kill switch.
		catalogPregate: read("SYFTHUB_CATALOG_PREGATE").toLowerCase() !== "off",
		// Auto-pick from VERIFIED pre-gate scores, skipping the router LLM (~1.3s) when the decision is
		// not genuinely ambiguous: survivors scoring ≥ this cross-encoder threshold are picked directly
		// (BGE scores are sharply bimodal — a direct hit is ~0.99, so 0.9 means near-certainty), and a
		// LONE surviving FREE source is picked without the LLM regardless of score (routing over one
		// candidate can only pick it or decline, and declining only matters for cost — a lone METERED
		// survivor still consults the LLM, preserving its veto over spend). ≤ 0 disables BOTH rules
		// (every routed turn goes to the LLM as before the knob). Only applies when the router is
		// ENABLED (not shadow — shadow exists to compare the real router against embedding discovery).
		routerAutopickScore: readFloat("SYFTHUB_ROUTER_AUTOPICK_SCORE", 0.9),
	};
}

/** The federated store requires a token; without one it is skipped entirely. */
export function syftEnabled(): boolean {
	return syft().token.length > 0;
}

/** PROMPT-RESTRICTED SyftHub routing (demo / controlled mode). When enabled the federated store fires
 *  ONLY on the prompts configured in ./syftPrompts.json and ONLY against the `owner/slug` data stores
 *  attached to the matched prompt — discovery, the LLM router, and the catalog pre-gate are all bypassed,
 *  so the attached stores are ALWAYS consulted. Every OTHER prompt gets no SyftHub at all. Enabled by
 *  SYFTHUB_PROMPT_ROUTING, OR implied by the stricter SYFTHUB_PROMPT_ONLY (see syftPromptOnly). Default
 *  OFF ⇒ today's discovery-driven behavior is unchanged. See ./syftPrompts.ts + index.ts. */
export function syftPromptRoutingEnabled(): boolean {
	if (syftPromptOnly()) {
		return true; // prompt-only is the strict superset — it always routes by prompt
	}
	const v = read("SYFTHUB_PROMPT_ROUTING").toLowerCase();
	return v === "on" || v === "true";
}

/** HARD prompt-only kill switch. When "on" (or "true"), SyftHub is allowed to fire ONLY on matched
 *  prompts and NOTHING else: it implies prompt routing (above), AND it force-disables the pre-flight
 *  LLM router + shadow (see syftRouter) — which in turn suppresses the warm catalog leg (warmSyftCatalog
 *  self-gates on the router being active). So there is no discovery, no router, and no off-turn SyftHub
 *  warming: the ONLY code path that ever touches SyftHub is a matched prompt's direct retrieval from its
 *  attached endpoints. Default OFF. */
export function syftPromptOnly(): boolean {
	const v = read("SYFTHUB_PROMPT_ONLY").toLowerCase();
	return v === "on" || v === "true";
}

/** SyftHub PRE-FLIGHT ROUTER config (RAG_ROUTER_*). An LLM reasons over the small data-source catalog
 *  to pick endpoints, replacing the weak cosine-over-metadata discovery. ALL gated, default OFF — with
 *  the router off, discoverSources is byte-for-byte today's embedding path. Distinct prefix from the
 *  unrelated `LLM_ROUTER_*` (Arch-Router model selection) so the two subsystems are never conflated.
 *  See docs/plans/syfthub-preflight-router.md. */
export function syftRouter() {
	// PROMPT-ONLY mode force-disables the router (and, via warmSyftCatalog's `enabled||shadow` gate, the
	// off-turn warm catalog leg): in that mode SyftHub must fire ONLY on matched prompts, which retrieve
	// directly from their attached endpoints — the router/discovery path is never wanted, so no env
	// combination (RAG_ROUTER_ENABLED / _SHADOW) can re-arm it.
	const promptOnly = syftPromptOnly();
	return {
		// Master gate. Off ⇒ embedding discovery exactly as today.
		enabled: !promptOnly && read("RAG_ROUTER_ENABLED") === "true",
		// Shadow mode: the router RUNS and logs routed-vs-embedding picks, but embedding discovery still
		// drives retrieval (and confident-empty is never honored). Activates the router INDEPENDENTLY of
		// `enabled` — you can shadow-eval recall delta with zero risk before flipping the master gate.
		shadow: !promptOnly && read("RAG_ROUTER_SHADOW") === "true",
		// Wiring-layer policy (NOT in the router-decision cache key): honor a confident router `empty` as
		// "no federated grounding". Default false ⇒ a confident empty falls through to embedding discovery
		// (no change). Enable only after shadow-eval shows acceptable recall loss.
		honorEmpty: read("RAG_ROUTER_HONOR_EMPTY") === "true",
		// Chat model id for the routing call. Empty ⇒ the shared primary served model (primaryModelId).
		model: read("RAG_ROUTER_MODEL"),
		// DEDICATED served-model lane for the routing call ONLY (base / key / provider-pin). The routing
		// completion is the turn's FIRST upstream hit, so on a scale-to-zero main lane (CSCS) it
		// eats the cold-start 503 and loses the race — while the SDK-backed main gen rides the cold start
		// out via its built-in retries. Pointing the router at an ALWAYS-WARM lane (e.g. the HF router) keeps it fast (~1-2s) so the metered retrieval keeps its budget. Each
		// is read raw (NOT firstKey — falling back to the main OPENAI_* value is the intended default, not a
		// warn-worthy wrong-key event); empty ⇒ routeEndpoints falls back to the main OPENAI_BASE_URL /
		// OPENAI_API_KEY / OPENAI_PROVIDER, so unset keeps the main lane.
		baseUrl: read("RAG_ROUTER_BASE_URL"),
		apiKey: read("RAG_ROUTER_API_KEY"),
		provider: read("RAG_ROUTER_PROVIDER"),
		// Requested soft cap (ms) for the WHOLE preflight (catalog + LLM). The EFFECTIVE cap is
		// min(this, retrieveTimeoutMs − MIN_FALLBACK_BUDGET_MS); ≤ 0 ⇒ router disabled for the turn so the
		// embedding fallback + metered retrieval always keep their reserve (see effectiveRouterCap).
		timeoutMs: readNumber("RAG_ROUTER_TIMEOUT_MS", 4000),
		// Hard cap on picks — bounds metered fan-out / cost.
		maxEndpoints: readNumber("RAG_ROUTER_MAX_ENDPOINTS", 3),
		// Catalog (hub.browse) cache TTL — long, because the router-decision fingerprint includes the
		// prompt-relevant catalog fields, so a description/tag change reshapes it and invalidates stale picks.
		catalogTtlMs: readNumber("RAG_ROUTER_CATALOG_TTL_MS", 3600000),
		// Semantic decision cache: on an exact-key miss, the (memoized, ~ms warm) query embedding is
		// compared against cached decisions' embeddings within the same catalog/model scope, and a cosine
		// ≥ semCacheMin reuses the cached decision — paraphrases ("what does EPFL publish" vs "EPFL
		// publications") skip the ~1.3s LLM call the exact-match cache misses on. Fail-open: no embedding
		// ⇒ straight to the LLM. Default ON; SYFTHUB_ROUTER_SEMCACHE=off is the kill switch.
		semCache: read("SYFTHUB_ROUTER_SEMCACHE").toLowerCase() !== "off",
		// Cosine floor for a semantic-cache hit. Deliberately tight (paraphrase-level, not topic-level):
		// two queries about the same SOURCE can still deserve different pick sets, so only near-identical
		// intent reuses a decision. Raise toward 1.0 to be stricter; ≥ 1 effectively disables reuse.
		semCacheMin: readFloat("SYFTHUB_ROUTER_SEMCACHE_MIN", 0.95),
	};
}

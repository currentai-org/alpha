/**
 * Turn-relative wall-clock timings for a single assistant turn.
 *
 * {@link TurnSpans} is the mutable per-turn SINK the server threads through the retrieval,
 * generation, and output-screening layers so each can record its own phase without inventing a
 * return-value channel (the streams yield MessageUpdates, not timings). The conversation POST
 * handler creates one sink, passes it down, and folds it into {@link MessageTimings} at persist
 * time — so the full decomposition survives on the message in the DB instead of living only in
 * short-retention platform logs. Every field is an optional number: a turn that never reaches a
 * phase (declined, cache-served, router-off, screening-disabled) simply omits it.
 *
 * All values are milliseconds. Unless a field says otherwise, sub-spans are the wall-clock of a
 * single stage (NOT cumulative from request start); only ttftMs/totalMs/rawFirstTokenMs/screenHoldMs
 * and preStreamMs are measured from promptedAt (request start).
 */
export interface TurnSpans {
	// ── pre-stream critical path in conversation/[id]/+server.ts ───────────────────
	// The stretch between promptedAt and stream construction, now overlapped: settings + the gate/RAG/
	// web legs launch concurrently instead of serializing. Each is the wall-clock of its own step so a
	// regression in any one is queryable, not just visible as a single dark gap.
	/** Conversation load ∥ rate-limit (Promise.allSettled) wall. */
	convLoadMs?: number;
	/** parseChatRequest (multipart body → typed turn inputs) wall. */
	parseMs?: number;
	/** claimGeneration (idempotency claim) wall. */
	claimMs?: number;
	/** settings.findOne promise wall (launched with the legs post-claim; feeds billing/overrides). */
	settingsMs?: number;
	/** User-msg persist link wall (the first conversation-write-chain link). */
	persistUserMsgMs?: number;
	/** promptedAt → stream construction (the whole pre-stream stretch). Cumulative from request start. */
	preStreamMs?: number;

	// ── math routing (CUR-2065, CUR-2198) ────────────────────────────────────────────────────────
	/** The turn planner's forced call (`planTurn`), timeout and failure paths included; present on every
	 *  turn math routing planned, absent otherwise. It runs after preStream and before the generation
	 *  pre-passes, so it sits outside every other stage. Its outcome is on the turn's `math-route` rung. */
	turnPlanMs?: number;
	/** The retired ledger call (`extractLedger`) on turns before CUR-2198; only the regex floor's turns
	 *  carry it. Kept so `ttft-baseline` still reads those rows. */
	mathLedgerMs?: number;

	// ── native calculate tool (CUR-2273) ─────────────────────────────────────────────────────────
	/** Summed over tool rounds: from the model's tool calls to the next request's response headers
	 *  (evaluation is microseconds; the rest is the extra request). Absent when no round ran. */
	calculateToolMs?: number;
	/** The part of calculateToolMs spent running the tools (web search), summed over rounds. (CUR-4282) */
	toolRunMs?: number;
	/** How many tool rounds this answer took. */
	calculateToolRounds?: number;

	// ── SyftHub federated retrieval, decomposed (all otherwise opaque inside ragMs) ──────────────
	/** Catalog PRE-gate: one cross-encoder score of the whole catalog BEFORE the router (preGateCatalog).
	 *  A verified-empty result here skips router + discovery + pick gate + metered retrieval entirely. */
	syftPregateMs?: number;
	/** hub.browse catalog fetch during discovery (the cold cost a warm leg would hide). */
	syftCatalogMs?: number;
	/** Pre-flight LLM routing over the catalog (routeEndpoints); 0/absent when the router is off. */
	syftRouterMs?: number;
	/** Cross-encoder pick relevance gate before the metered call (gatePicksByRelevance). */
	syftPickGateMs?: number;
	/** The PAID search.query retrieval leg. */
	syftMeteredMs?: number;

	// ── generation pre-passes + the model's first token (surfaced from textGeneration) ───────────
	/** All blocking pre-generation work before the model call (= worldModel + mcp + preprocess + rest). */
	preGenMs?: number;
	/** World-model pre-pass (INERT unless WORLD_MODEL_PREPASS). */
	worldModelMs?: number;
	/** MCP/tool pre-pass. */
	mcpMs?: number;
	/** preprocessMessages (multimodal/file resolution, etc.). */
	preprocessMs?: number;
	/** The shared media pass (prepareTurnMedia): hydrate + extract + cap + screening-encode, ONCE per
	 *  turn as a gate dependency. ~0 on a no-file turn (fast path); the file/image hydration cost on a
	 *  media turn. Distinct from preprocessMs, which is now just the endpoint projection of this. */
	mediaPrepMs?: number;
	/** hardenLastUserTurn — the user-role grounding/injection fence, incl. the semantic-locality embed. */
	hardenMs?: number;
	/** The model's own first-token latency, measured from the moment generate() was called. */
	genToFirstTokenMs?: number;
	/** The model's FIRST raw token, cumulative from promptedAt — the earlier half of the dual first-token
	 *  stamp. The later half is ttftMs (the first RELEASED token, after output+honesty screening). */
	rawFirstTokenMs?: number;

	// ── output screening (surfaced from screenOutputStream; absent when OUTPUT_MODERATION is off) ──
	/** Latency of the FIRST output screen — the batch the client can't see until it clears. */
	firstScreenMs?: number;
	/** Sum of every output-screen call's own latency (per-call cost, NOT wall-clock since calls overlap). */
	totalScreenMs?: number;
	/** Wall-clock span of the whole output-screening phase. */
	screenPhaseMs?: number;
	/** Part of screenPhaseMs spent waiting for the model's first token, before the idle window opened
	 *  (CUR-2243). Absent when no token arrived. */
	screenPreTokenWaitMs?: number;

	// ── coop overlap (historical: written only before the overlap was retired, CUR-92) ──────────────
	/** Generation events produced INSIDE the Coop window and held until the verdict landed. This is the
	 *  overlap actually achieved — every one is an event the serial ordering would still be waiting
	 *  on. A turn that reports 0 overlapped nothing, whatever the flag said. */
	speculativeEvents?: number;
	/** The gate blocked after generation had already started, so the held events were thrown away.
	 *  The rate of this across turns is what the speculation costs in wasted inference. */
	speculativeDiscarded?: boolean;

	/** DERIVED = max(0, ttftMs − rawFirstTokenMs): the hold between the model's first token and the first
	 *  byte RELEASED to the client (output-screen first-chunk hold + honesty/sentence accumulation). This
	 *  is the "unexplained" tail Phase 4 attributes and targets. */
	screenHoldMs?: number;
}

/**
 * The persisted timing shape on a Message. Extends {@link TurnSpans} with the two cumulative
 * request-relative anchors and the coarse phase split that predate the decomposition.
 */
export interface MessageTimings extends TurnSpans {
	/** request-start (promptedAt) → first answer token RELEASED to the client. */
	ttftMs?: number;
	/** request-start → done. */
	totalMs?: number;
	/** Safety pre-screen (Coop child/content + injection), now concurrent with retrieval. */
	gateMs?: number;
	/** RAG retrieval alone (catalog + admin + federated SyftHub). */
	ragMs?: number;
	/** RAG + open-web retrieval (the two overlap the pre-screen, so ttft ≈ max(gateMs, retrievalMs) + gen). */
	retrievalMs?: number;
	/** The web-search mode the request carried (off / auto / always), as the server saw it. */
	webSearchMode?: "off" | "auto" | "always";
}

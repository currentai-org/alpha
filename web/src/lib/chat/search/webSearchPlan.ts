import type { WebSearchMode } from "$lib/chat/stores/webSearchMode";

// Pure community-first web decision — kept in a LEAF module (no server/model imports) so the
// off/auto/always × community-sufficient matrix is testable in the hermetic CI gate, the same reason
// triggerStrategy.shouldRunSearch and rag/evidence.mergeRagEvidence are leaves. The chat handler
// (conversation/[id]/+server.ts) calls this AFTER running RAG to decide the web step.

/** Community-first web plan from the user's webSearchMode + whether community/RAG already covered the
 *  turn:
 *    "skip"      — don't search the web (off, or auto when community sufficed AND it's not a recency turn).
 *    "run"       — search the web unconditionally (always: explicit user choice, skip the margin gate).
 *    "auto-gate" — ask the margin gate (decideWebSearch) whether to search.
 *  `mode` undefined defaults to "off" (older clients / missing field). */
export function webSearchPlan(opts: {
	mode: WebSearchMode | undefined;
	communitySufficient: boolean;
	// Cheap deterministic recency signal (isRecencyQueryDenoised): the query wants CURRENT info the static
	// community catalog can't hold ("latest", "today", a year). When set, community sufficiency no longer
	// short-circuits the web in auto mode — we still consult the margin gate so the web can AUGMENT the
	// community sources for a recency turn (the catalog is a snapshot; "latest developments" needs the web).
	// Non-recency turns keep the fast community-first no-gate path (no extra classifier latency).
	recencyHint?: boolean;
	// Structurally-LIVE ask (live scores/prices/weather/breaking news — isUnservableLiveQuery) the open
	// engines can't serve. Forces skip-grounding, overriding even manual "always", so a pretend-search
	// never stamps the turn grounded on a topically-relevant but stale page. L3's relevanceVerified is a
	// backstop, but a live query can retrieve a relevant-but-stale page that clears the floor, so L2 must
	// gate the stamp independently of the reranker.
	unservableLive?: boolean;
}): "skip" | "run" | "auto-gate" {
	const mode = opts.mode ?? "off";
	if (mode === "off") return "skip";
	// Checked BEFORE "always": an explicit "always" must not force a pretend-search on a query the open
	// sources structurally can't answer. ("off" still wins — the user opted out of the web entirely.)
	if (opts.unservableLive) return "skip";
	if (mode === "always") return "run";
	return opts.communitySufficient && !opts.recencyHint ? "skip" : "auto-gate";
}

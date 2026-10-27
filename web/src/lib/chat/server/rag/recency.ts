// Recency-window detector for the RAG path.
//
// The committed local catalog (localStore) is built OFFLINE from the AI-ecosystem gap-map —
// it describes what projects/components exist, NOT what happened recently. A query about events
// in a recent time window ("what's happened … in the last month", "recent developments") is
// out-of-domain for it: the catalog can't contain the answer, yet same-domain taxonomy chunks
// still clear the 0.35 cosine floor and get returned as 5 "sources", which the model then
// mis-cites and confabulates around.
//
// So on a recency-window query we SKIP the stale local catalog. This is deliberately NOT the
// "recency forces web search" heuristic, which would feed the margin gate and lower
// search specificity. This only SUPPRESSES a store that is structurally incapable of
// answering; it has zero effect on the web-search trigger decision and adds no spurious calls.
//
// High precision by design: it matches recent-time-WINDOW phrasing ("last/past month", "this
// week", "what's happened", "recent developments/news") — NOT soft words like "latest"/"current"
// alone, which the catalog can legitimately answer ("latest open source vector stores").

const RECENCY_WINDOW =
	/\b(?:in\s+the\s+)?(?:last|past)\s+(?:few\s+|couple\s+(?:of\s+)?)?(?:\d+\s+)?(?:days?|weeks?|months?|years?|quarters?)\b|\bthis\s+(?:week|month|quarter|year)\b|\brecent(?:ly)?\s+(?:developments?|news|changes?|updates?|announcements?|events?|happenings?)\b|\bwhat(?:'s|\s+has|\s+have)?\s+happened\b|\bwhat's\s+new\b|\b(?:current|latest|recent)\s+news\b|\bas\s+of\s+(?:today|now|this\s+(?:week|month|year))\b|\bup[-\s]?to[-\s]?date\b|\bbreaking\s+news\b/i;

/**
 * True when the query asks about events in a recent time window — which the offline-built local
 * catalog cannot answer. Callers skip the local/admin catalog store for such turns.
 */
export function isRecencyWindowQuery(query: string | undefined): boolean {
	return RECENCY_WINDOW.test(query ?? "");
}

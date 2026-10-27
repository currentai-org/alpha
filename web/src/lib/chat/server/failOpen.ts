import { logger as defaultLogger } from "$lib/chat/server/logger";

/**
 * Fail-open branches and the state each one is expected to be in (CUR-68).
 *
 * Rerank, embeddings, guard screening, search and the agent stream all degrade instead of failing the
 * turn: the user gets a worse answer and a 200. Counting every fallback is noise, because many of them
 * are the design (rerank disabled, an empty query, the RAG similarity skip-floor). So each branch
 * declares what it is SUPPOSED to do, and only a departure from that is recorded.
 *
 * A departure is one warn line carrying two top-level fields, `failopen` (the branch) and `reason`.
 * Count them from Axiom's `vercel` dataset, which every environment drains into; `aipotluck` holds
 * prod only, and has no `failopen` column until prod carries this file (CUR-2142):
 *
 *     ['vercel'] | where message contains '[failopen]' | extend p = parse_json(message)
 *       | summarize count() by bin_auto(_time), env = tostring(['vercel.environment']),
 *           failopen = tostring(p['failopen']), reason = tostring(p['reason'])
 *
 * Never put user text in `fields`. The call sites pass counts, status codes and event names only.
 */
export type FailOpenBranch =
	/** An enabled reranker, given candidates, returns a usable score for them. */
	| "rerank"
	/** The RAG rerank wrapper returns without throwing. */
	| "rag-rerank"
	/** The embedding endpoint returns one vector for a non-empty query. */
	| "embed"
	/** Every guard unit returns a verdict, so content screening never falls through to allow. */
	| "guard"
	/** At least one of the engines asked for results answers without throwing. */
	| "search"
	/** The configured search decider returns a verdict, so no fallback (search under margin, the recency
	 *  regex under model/tool) decides in its place. */
	| "search-decision"
	/** The RAG entity-scope classifier returns a yes/no verdict, so no hit is kept for lack of one. */
	| "entity-scope"
	/** Every agent-service SSE frame that carries data names its event and parses as JSON. */
	| "agent-frame"
	/** The agent event stream ends on its own, by timeout, or by a user stop. */
	| "agent-stream";

type WarnLogger = { warn: (obj: Record<string, unknown>, msg: string) => void };

/** Record that `branch` left its declared expected state. `reason` is a short fixed token
 *  (`timeout`, `non-ok`, `unparseable-json`), not free text, so it groups in a query. */
export function failOpenDeparture(
	branch: FailOpenBranch,
	reason: string,
	fields: Record<string, unknown> = {},
	log: WarnLogger = defaultLogger
): void {
	log.warn(
		{ ...fields, failopen: branch, reason },
		`[failopen] ${branch} departed from its expected state (${reason})`
	);
}

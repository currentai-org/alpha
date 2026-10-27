// RAG orchestration — the single entry point the chat flow calls per turn.
//
//   maybeRagGrounding(query, locals):
//     gate on RAG_ENABLED → route to stores (decideRagSources) → fetch the
//     selected stores in parallel → merge into one grounding context.
//
// FAIL-OPEN everywhere: the feature is additive. Disabled, no store selected, or
// every store failing → null, and the chat answers normally. The local catalog
// store needs only the committed index; the federated SyftHub store needs a
// SyftHub token (see ./env, ./syftSources). Server-side, like the MCP path — not
// client-triggered like open-web search.

import type { RagContext, RagSource } from "$lib/chat/types/Rag";
import { ragEnabled, ragAdminEnabled, syftPromptRoutingEnabled } from "./env";
import { decideRagSources } from "./router";
import { matchSyftPromptEndpoints } from "./syftPrompts";
import { queryLocalStore, localStoreReady } from "./localStore";
import { queryAdminStore, type RagWorkspace } from "./adminStore";
import { querySyftSources } from "./syftSources";
import { mergeRagEvidence, withTimeout } from "./evidence";
import { rerankRagHits } from "./rerankRag";
import { entityScopeGuardEnabled, filterByEntityScope } from "./entityScopeGuard";
import { rerankEnabled } from "$lib/chat/server/search/rerank";
import { isRecencyWindowQuery } from "./recency";
import { expandWholeDocuments } from "./wholeDocuments";
import { logger } from "$lib/chat/server/logger";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";

// mergeRagEvidence + withTimeout live in ./evidence (a leaf module) so they're testable in the
// hermetic CI gate — this orchestrator pulls the model/router graph in via decideRagSources.
export { mergeRagEvidence } from "./evidence";

/**
 * Whether maybeRagGrounding will query our document stores for this text, rather than return null
 * at once. The live status line names a document search only when this is true (CUR-2223).
 */
export function ragWillSearch(query: string | undefined): boolean {
	return ragEnabled() && (query ?? "").trim().length >= 3;
}

/** Run the selected RAG stores for this turn and merge them; null to answer normally.
 *  `startAt` offsets the RAG citation numbers so they continue after any open-web sources
 *  already numbered for this turn (one global citation namespace shared with the UI). */
export async function maybeRagGrounding(
	query: string | undefined,
	locals: App.Locals | undefined,
	startAt = 0,
	// Optional per-turn timing sink; forwarded to querySyftSources for the federated stage
	// decomposition (catalogMs/routerMs/pickGateMs/meteredMs) that otherwise hides inside ragMs.
	spans?: TurnSpans,
	// The workspace whose own documents this turn may cite besides the site-wide ones. (CUR-4152)
	workspaceId: RagWorkspace = null
): Promise<RagContext | null> {
	const q = (query ?? "").trim();
	if (!ragWillSearch(q)) {
		return null;
	}

	let selection;
	try {
		selection = await decideRagSources();
	} catch (e) {
		logger.warn(e, "[rag] routing failed; answering without RAG grounding");
		return null;
	}

	// Recency-window queries ("what's happened … in the last month") are out-of-domain for the
	// OFFLINE-built local catalog: it describes the ecosystem's structure, not recent events, so its
	// same-domain chunks clear the cosine floor and get mis-cited + confabulated around.
	// Skip the stale catalog (local + admin) on those turns; the turn then answers
	// without catalog grounding (and the unbacked-citation guard cleans any invented [n]). This does
	// NOT touch the web-search decision — see ./recency for why that distinction matters.
	const skipStaleCatalog = isRecencyWindowQuery(q);
	if (skipStaleCatalog) {
		// Length only, never the query text (all three logger calls in this file, same fix). (CUR-918)
		logger.info({ qLength: q.length }, "[rag] recency-window query — skipping the offline catalog");
	}

	const localP =
		selection.local && !skipStaleCatalog && localStoreReady()
			? withTimeout(queryLocalStore(q), 8000, [] as Omit<RagSource, "n">[])
			: Promise.resolve([] as Omit<RagSource, "n">[]);
	// Admin-authored store runs on the same `local` signal (both are Potluck-family) but as its
	// OWN promise+timeout — never folded into queryLocalStore, so a slow DB can't drop committed
	// catalog hits under a shared timeout. Gated OFF by default (RAG_ADMIN_ENABLED): when off we
	// don't even build the promise, so the per-turn path never touches the DB. Also skipped for
	// recency-window queries (same offline-staleness reason as the committed catalog).
	const adminP =
		selection.local && !skipStaleCatalog && ragAdminEnabled()
			? withTimeout(queryAdminStore(q, workspaceId), 8000, [] as Omit<RagSource, "n">[])
			: Promise.resolve([] as Omit<RagSource, "n">[]);
	// PROMPT-RESTRICTED SyftHub (SYFTHUB_PROMPT_ROUTING, or the stricter SYFTHUB_PROMPT_ONLY): the
	// federated store fires ONLY on prompts configured in ./syftPrompts.json, and ONLY against the
	// endpoints attached to the matched prompt — those exact data stores are then queried DIRECTLY
	// (querySyftSources bypasses discovery/router/pre-gate/pick-gate). Any other prompt gets no SyftHub.
	// SYFTHUB_PROMPT_ONLY additionally force-disables the router + warm catalog leg (see env.syftRouter).
	// OFF (default) ⇒ discovery-driven as today.
	const promptRouting = syftPromptRoutingEnabled();
	const forcedEndpoints = promptRouting && selection.syft ? matchSyftPromptEndpoints(q) : [];
	const runSyft = promptRouting ? forcedEndpoints.length > 0 : selection.syft;
	if (promptRouting && selection.syft && forcedEndpoints.length === 0) {
		logger.info(
			{ qLength: q.length },
			"[rag] SyftHub prompt-routing on — no configured prompt matched; skipping the federated store"
		);
	}
	// Federated SyftHub store (Pattern A: discover → retrieve). NO withTimeout wrapper — the single
	// deadline + metered-call abort lives inside querySyftSources (see syftSources.ts), which always
	// resolves [] by its own deadline. One timer, so no env override can reorder two timers. In
	// prompt-routed mode the caller hands querySyftSources the attached endpoints (discovery skipped).
	const syftP = runSyft
		? querySyftSources(q, spans, promptRouting ? forcedEndpoints : undefined)
		: Promise.resolve([] as Omit<RagSource, "n">[]);

	const [local, admin, syft] = await Promise.all([localP, adminP, syftP]);

	// Merge in source order — catalog (committed Potluck) first, then admin community, then federated.
	// This is the citation order on the DEGRADE/disabled path (and the grounding prompt states the
	// catalog preference independently of order); a VERIFIED rerank below reorders by cross-encoder
	// relevance, so a strong federated hit can then legitimately outrank a weak catalog one.
	const hits = [...local, ...admin, ...syft];
	if (hits.length === 0) {
		return null;
	}

	// Cross-encoder relevance gate — the SAME open BGE reranker (RERANK_MODEL) web search uses, over
	// ALL merged RAG hits (local + admin + federated SyftHub) in one pass. When it VERIFIES it reorders
	// and drops off-topic hits below RAG_RERANK_MIN_SCORE; when it can't (disabled / cold / timeout) it
	// DEGRADES to the cosine/similarity-floored hits unchanged, so grounding never regresses below
	// today's floor on an infra failure. See rerankRag.ts for the full policy.
	const { hits: reranked, relevanceVerified } = await rerankRagHits(q, hits);
	// Relevance and entity attribution are different axes (CUR-43): a hit can be topically relevant
	// (clears rerankRagHits) while being about the wrong entity, which is invisible to a relevance
	// gate by construction. See entityScopeGuard.ts for the fail-open policy.
	const ranked = entityScopeGuardEnabled() ? await filterByEntityScope(q, reranked, locals) : reranked;
	// Best upstream (store-reported) similarity across the merged hits — the calibration signal for the
	// RAG_RERANK_SKIP_COSINE_BELOW skip-floor (see rerankRagHits): logged on both outcomes below so the
	// score distribution of kept-0 vs grounded turns is readable straight from prod logs.
	const bestScore = hits.reduce((m, h) => Math.max(m, h.score ?? 0), 0);
	if (ranked.length === 0) {
		// Reachable on a VERIFIED all-below-floor rerank, on the (opt-in) similarity skip-floor
		// short-circuit, or on every surviving hit failing entity scope (CUR-43) — either way every
		// retrieved source is off-topic or off-entity, so answer ungrounded rather than citing [n] on
		// chunks the gate wouldn't vouch for (matches the web-search gate).
		// Log the question's length, never its text — the logs keep full retention with no
		// purge path. The score fields below make the score distribution of kept-0 vs grounded turns
		// readable straight from prod logs. (CUR-1721)
		logger.info(
			{ qLength: q.length, retrieved: hits.length, rerankedTo: reranked.length, bestScore },
			"[rag] no hits survived reranking or entity scoping — answering without RAG grounding"
		);
		return null;
	}
	if (rerankEnabled()) {
		// Observability parity with the web path's groundedWeb log. `kept < retrieved` means the
		// cross-encoder dropped off-topic hits (catalog or federated), or the entity-scope guard dropped
		// an off-entity one; relevanceVerified=false means the reranker couldn't vet this turn
		// (cold/failed lane) so grounding degraded to the cosine/similarity floor. A grounded turn with
		// irrelevant federated sources + relevanceVerified=false is the tell that the warm reranker
		// endpoint isn't reachable.
		logger.info(
			{ retrieved: hits.length, kept: ranked.length, relevanceVerified, bestScore },
			"[rag] relevance gate applied"
		);
	}
	// A kept admin-store chunk brings its whole document, within a per-turn budget. (CUR-4296)
	const { hits: cited, bodies } = await expandWholeDocuments(ranked, relevanceVerified);
	return mergeRagEvidence(q, cited, undefined, startAt, relevanceVerified, bodies);
}

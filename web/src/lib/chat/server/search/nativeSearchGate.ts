// On a native turn the model decides whether to search, and it can answer a rights question
// (an England eviction notice, France's VAT, Ontario's firing rules) from memory when it should search.
// The embedding gate the pipeline
// turn asks (searchIntent.ts) says search for all four rights questions in its holdout. This asks it on
// an Auto native turn, so a "search" verdict forces the first round to web_search (nativeTools.ts); a
// "no", no opinion, or a gate slower than the budget leaves the choice with the model, as before. (CUR-4083)

import { decideSearchViaIntent } from "./searchIntent";
import { readIdentityWithin, type SelfIdentityVerdict } from "$lib/chat/server/selfIdentity";
import { logger } from "$lib/chat/server/logger";

/** The pipeline turn gives the identity veto the same 1.5 s (+server.ts); a warm embedder takes ~150 ms. */
const NATIVE_GATE_BUDGET_MS = 1_500;

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([p, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

/**
 * True only when the embedding gate says this message needs the web, the self-identity verdict does
 * not say it is a question about Alpha itself (CUR-2135: those are answered from provenance, never the
 * web), and our catalog has nothing for it. A native turn reads the catalog through `search_catalog`,
 * so no catalog hit exists before the turn; `readCatalogHits` looks once, the way the pipeline turn's
 * community-first plan does (webSearchPlan.ts), and a hit leaves the choice with the model unless the
 * message wants something recent. Never rejects, and never says true without an `ok` gate verdict
 * inside the budget.
 */
export async function nativeGateSaysSearch(
	text: string,
	readSelfIdentity?: () => Promise<SelfIdentityVerdict>,
	budgetMs = NATIVE_GATE_BUDGET_MS,
	readCatalogHits?: () => Promise<number>,
	recencyHint = false
): Promise<boolean> {
	const [gate, { verdict: identity, reading }, catalogHits] = await Promise.all([
		within(decideSearchViaIntent(text).catch(() => undefined), budgetMs),
		readIdentityWithin(readSelfIdentity, budgetMs, "native-search-gate"),
		readCatalogHits && !recencyHint ? within(readCatalogHits().catch(() => 0), budgetMs) : undefined,
	]);
	if (!gate?.ok || !gate.shouldSearch) return false;
	if (catalogHits) {
		logger.info(
			{ leg: "native-search-gate", margin: gate.margin, catalogHits },
			"[search] gate said search; our catalog has it, so not forcing it"
		);
		return false;
	}
	if (identity?.isSelf) {
		logger.info(
			{ leg: "native-search-gate", margin: gate.margin, identityMargin: identity.margin },
			"[search] gate said search; a question about Alpha itself, so not forcing it"
		);
		return false;
	}
	logger.info(
		{ leg: "native-search-gate", margin: gate.margin, ...reading },
		"[search] gate said search; forcing web_search"
	);
	return true;
}

/** Whether a native turn's first round is forced to web_search. "always" forces it. CUR-4083: on Auto,
 *  the embedding gate's "search" forces the search the model sometimes skips, unless a photo or a pasted
 *  link came with the message, which the turn reads first (CUR-3192, CUR-2734). */
export function forcesWebSearch(t: {
	mode: "off" | "auto" | "always" | undefined;
	photoAttached: boolean;
	pastedUrl: boolean;
	gateSaysSearch: boolean;
}): boolean {
	if (t.mode === "always") return true;
	return t.mode === "auto" && t.gateSaysSearch && !t.photoAttached && !t.pastedUrl;
}

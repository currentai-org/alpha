// Pure evidence helpers for the RAG orchestrator, kept in a LEAF module (types only — no
// router/store imports) so they load in the hermetic CI gate. The orchestrator (./index)
// pulls the model/router graph in via decideRagSources, which is why these can't be unit-
// tested there; here they are import-clean.

import type { RagContext, RagSource } from "$lib/chat/types/Rag";
import { formatRagEngine } from "$lib/chat/utils/formatRagEngine";

/** Resolve a promise to a fallback if it doesn't settle in time. REJECT-SAFE: a rejected
 *  `p` resolves to `fallback` too, so a throwing store can never propagate through the
 *  orchestrator's `Promise.all` and error the whole turn (the fail-open invariant). Keeps
 *  one slow/failing store from blocking the turn (the SDK's own timeout is much longer). */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		Promise.resolve(p).catch(() => fallback),
		new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

/** Like {@link withTimeout}, but runs `onTimeout()` exactly once if the timer wins — used by the
 *  SyftHub path to `AbortController.abort()` an in-flight METERED retrieval before resolving the
 *  fallback, so an abandoned call cannot keep running and settle. REJECT-SAFE like withTimeout;
 *  the pending timer is cleared once the race settles, so `onTimeout` never fires when `p` wins. */
export function withDeadline<T>(
	p: Promise<T>,
	ms: number,
	onTimeout: () => void,
	fallback: T
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<T>((resolve) => {
		timer = setTimeout(() => {
			onTimeout();
			resolve(fallback);
		}, ms);
	});
	return Promise.race([Promise.resolve(p).catch(() => fallback), deadline]).finally(() =>
		clearTimeout(timer)
	);
}

/** Said beside every catalog entry in the prompt. A catalog entry describes some other project, and
 *  the model otherwise reads "OpenAI Web Search" as an account of its own search tool (CUR-3304). */
const CATALOG_ENTRY_NOTE =
	"(Catalog entry about another project listed in the AI Potluck catalog. It describes that project, never this app or its own tools.)";

/** A catalog entry is a source whose page is one of our catalog `/product/…` or `/org/…` pages. */
function isCatalogEntry(s: Pick<RagSource, "url">): boolean {
	if (!s.url) return false;
	try {
		const u = new URL(s.url, "https://www.aipotluck.org");
		return /(^|\.)aipotluck\.org$/.test(u.hostname) && /^\/(product|org)\/[^/]+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

/** Number the citable sources and render the evidence block injected into the prompt.
 *  `startAt` offsets the citation numbers into one global namespace shared by the model, the UI
 *  strips, and the guards. In the live pipeline RAG/community runs FIRST (startAt=0 → [1..k]) and
 *  the open web continues after it (runWebSearch startAt=communityCount → [k+1..]); `startAt` stays
 *  general so the two layers can be numbered in either order without renumbering the other. */
export function mergeRagEvidence(
	query: string,
	hits: Omit<RagSource, "n">[],
	vaultSynthesis: string | undefined,
	startAt = 0,
	relevanceVerified = false,
	// Index into `hits` → text the model reads in place of that hit's snippet (a whole document,
	// wholeDocuments.ts). The prompt only: `sources`, which is persisted and streamed, keeps the snippet.
	bodies: ReadonlyMap<number, string> = new Map()
): RagContext {
	const sources: RagSource[] = hits.map((h, i) => ({ ...h, n: startAt + i + 1 }));
	const evidence = sources
		.map(
			(s, i) =>
				`[${s.n}] ${s.title} (${formatRagEngine(s)})\n${isCatalogEntry(s) ? `${CATALOG_ENTRY_NOTE}\n` : ""}${bodies.get(i) ?? s.snippet}${s.url ? `\n${s.url}` : ""}`
		)
		.join("\n\n");
	return {
		query,
		sources,
		evidence,
		asOf: new Date().toISOString(),
		vaultSynthesis: vaultSynthesis || undefined,
		// Server-local provenance bit (see RagContext). Defaults false so the vault-only path and any
		// caller that doesn't rerank stays honest ("not cross-encoder-verified").
		relevanceVerified,
	};
}

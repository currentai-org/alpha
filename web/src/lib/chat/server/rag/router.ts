// Auto-router: decide which RAG stores to consult for a turn WITHOUT asking the user to pick.
//
// The local catalog store is the safe default (this is the AI-ecosystem product). The federated
// SyftHub store is consulted whenever it is configured — there is no per-source keyword routing
// anymore: discovery (client.hub.search) decides WHICH specific sources are relevant and at what
// score, so the old EPFL/Vault regexes + classifier are gone. See syftSources.ts.
//
// Kept import-clean (no model graph) so the hermetic CI gate loads router/evidence without
// OPENAI_BASE_URL (see vite.config.ts).

import type { RagSourceSelection } from "$lib/chat/types/Rag";
import { syftEnabled } from "./env";

/** Pure selection: local is always on; the federated store is on whenever a SyftHub token is
 *  configured. The per-query relevance decision happens inside discovery, not here. */
export function heuristicSources(): RagSourceSelection {
	return { local: true, syft: syftEnabled() };
}

/** Decide which stores to consult this turn. Async-returning for call-site stability. */
export async function decideRagSources(): Promise<RagSourceSelection> {
	return heuristicSources();
}

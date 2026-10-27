import type { RagSource } from "$lib/chat/types/Rag";

/** Display label for a RAG source. The generic `SyftHub` engine carries the specific source's
 *  `owner/slug` in `sourceName`, rendered as `SyftHub:<sourceName>`; every other engine (incl.
 *  the legacy `SyftHub:EPFL`/`SyftHub:Vault` on persisted messages) renders its label verbatim.
 *  Single source of truth so the evidence block, source strip, export, and provenance envelope
 *  all show the per-source name consistently. */
export function formatRagEngine(source: Pick<RagSource, "engine" | "sourceName">): string {
	if (source.engine === "SyftHub" && source.sourceName) {
		return `SyftHub:${source.sourceName}`;
	}
	// The person's own earlier chats, named the way the note under the answer names them. (CUR-4576)
	if (source.engine === "PastChat") return "your past chats";
	return source.engine;
}

// Shared types for RAG-store grounding. The local Tier-A store, the admin catalog store, and the
// federated SyftHub store (Pattern A) all return citable snippets (numbered sources). The
// `vaultSynthesis` field below is retained only for back-compat with messages persisted by the
// earlier synthesis-vault path — nothing produces it anymore.

/** Which store a source came from — also the label shown in the evidence block.
 *  `Potluck:Community` is admin-authored catalog content (the upload feature); it is
 *  Potluck-family but labeled distinctly so the UI never claims it is gap-map data.
 *  `SyftHub` is the generic Pattern-A federated source (the specific source's owner/slug
 *  lives in `sourceName`); `SyftHub:EPFL`/`SyftHub:Vault` are retained so messages persisted
 *  by the earlier two-source path still type-check and render. */
export type RagEngine =
	| "Potluck"
	| "Potluck:Community"
	| "SyftHub"
	| "SyftHub:EPFL"
	| "SyftHub:Vault"
	/** A passage from one of the signed-in person's own earlier chats (rag/pastChats.ts). (CUR-4576) */
	| "PastChat";

/** A single retrieved, citable snippet. */
export type RagSource = {
	n: number; // citation number, assigned at merge time
	title: string;
	url?: string;
	snippet: string;
	engine: RagEngine;
	// For the generic `SyftHub` engine, the owning data source's `owner/slug` (from the
	// retrieved doc) — composed into the display label as `SyftHub:<sourceName>` via
	// formatRagEngine. Optional so other engines and persisted messages compile unchanged.
	sourceName?: string;
	score?: number; // similarity/relevance (0-1) where the store reports it
	// Optional provenance for admin-authored chunks (the upload feature). Optional so the
	// existing Potluck/EPFL callers compile unchanged and persisted messages stay valid.
	chunkId?: string;
	documentId?: string;
	sourceDate?: string; // ISO date the underlying item is dated/published
	version?: number; // document version this chunk was embedded from
};

/** What the orchestrator hands the grounding injector for a turn. */
export type RagContext = {
	query: string;
	sources: RagSource[];
	evidence: string; // numbered evidence block built from `sources`
	asOf: string; // ISO timestamp the retrieval ran
	/** Synthesized answer from the federated vault, kept apart from numbered sources. */
	vaultSynthesis?: string;
	/** SERVER-LOCAL grounding-provenance bit: true IFF the cross-encoder reranker actually vetted this
	 *  turn's sources (see rerankRagHits). It is the RAG analog of WebSearchOutcome.relevanceVerified and,
	 *  like it, MUST NOT cross the client boundary — ragProvenance (the persisted `message.rag`) and the
	 *  MessageRag stream update both drop it, so a client can never *claim* verification. It is
	 *  PROVENANCE/telemetry only, NOT a hard grounding gate: unlike web search's BM25 order, RAG hits
	 *  already cleared a real relevance floor (cosine ≥ RAG_MIN_SCORE, or the SyftHub similarity
	 *  threshold), so grounding on the degrade path (verified=false) stands on that floor. */
	relevanceVerified?: boolean;
};

/** Which stores the router selected for a turn. `syft` gates the Pattern-A federated
 *  store (discovery decides the specific sources, so this is just on/off). */
export type RagSourceSelection = {
	local: boolean;
	syft: boolean;
};

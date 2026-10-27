// Decides which live-stack nodes a FINISHED turn lights, in real pipeline order.
//
// Honest by construction — this is a provenance invariant, not cosmetics:
//   - a moderation-declined turn never reached the model, so it lights ONLY the
//     pre-model safety screen (Shieldstral-1.0-3B child/content under guard-primary, Coop only as the
//     flag-off fallback), never Apertus;
//   - retrieval nodes (web search, RAG stores) appear only when that layer ran;
//   - the compute cell lights only when the answer TRULY ran on that institution's hardware,
//     resolved from the backend the gateway reported for this answer;
//   - otherwise the model node alone.
//
// The compute cell's node is passed in by the caller, resolved from the backend the gateway reported
// for this answer. A deployment-wide boolean such as `serving.isSovereign` must not stand in for it:
// it is true for every turn, so the CSCS node would light on turns another provider served (CUR-75).
// The caller passes the NODE, resolved from a measurement, so there is no
// place for "the lane is sovereign" to stand in for "this institution ran it".

import type { RagEngine, RagSource } from "$lib/chat/types/Rag";
import { backendHost } from "$lib/chat/servingProvenance";

// SINGLE SOURCE OF TRUTH for live-stack node ids. Every surface that lights/flashes/
// pulses a map node imports these — never a bare "apertus"/"websearch" literal — so a
// rename in static/data/stack-map.json can't silently leave a dispatcher pointing at a
// dead node (reveal.spec.ts asserts each id exists in the map).
export const MODEL_NODES = ["apertus"] as const;

export const COMPUTE_NODE = "cscs";

// Which stack-map node a CURATED, authored backend corresponds to (CSCS has real lineage copy in
// stack-map.json — a trained-here story worth its own hand-written node). A backend NOT in this map
// still lights, via backendComputeNode's synthesis below — this table is no longer "the backends we
// can show at all", only "the ones with bespoke copy". CUR-1124: synthesis means a provider with
// real traffic (Infomaniak, for one) lights without anyone adding an entry here.
const BACKEND_COMPUTE_NODES: Record<string, string> = {
	"api.inference.cscs.ch": COMPUTE_NODE,
};

// Our own routing/gateway hosts, and a provider's own opaque front door — never a nameable compute
// institution, so never synthesize a node for these even though they're real, measured hosts. Naming
// the gateway as if it were the datacenter is the exact conflation this map exists to avoid.
const NOT_A_BACKEND = new Set(["api-internal.publicai.co", "router.huggingface.co"]);

// Synthesized node ids for a MEASURED backend not in the curated map above. `compute:${host}` is
// stable and honest — it names exactly the host the gateway reported, nothing more — and
// stackNodes.ts's synthesizeComputeNode() turns it into real display copy (sovereign framing gated on
// servingProvenance.ts's own backendIsSwiss(), never invented here). Only a truly unmeasured backend
// (no host at all, or a gateway/routing host with nothing behind it to name) stays dark.
export function backendComputeNode(backendBaseURL?: string): string | undefined {
	const host = backendHost(backendBaseURL);
	if (!host || NOT_A_BACKEND.has(host)) return undefined;
	return BACKEND_COMPUTE_NODES[host] ?? `compute:${host}`;
}

// Same shape, model side: MODEL_NODES[0] ("apertus") has real lineage copy (training data, the
// technical report) worth a hand-authored node. Any other served model still lights, via a
// synthesized `model:${slug}` id — honest by construction because the slug is derived from the
// measured served id, never guessed. CUR-1124: a cross-model fallback (GLM, or the sea-lion Qwen
// fine-tune LiteLLM substitutes) lights its own node, not the Apertus node.
export function modelNodeFor(servedModelId?: string): string {
	if (!servedModelId || servedModelId.toLowerCase().includes("apertus")) return MODEL_NODES[0];
	const slug = servedModelId
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `model:${slug}` : MODEL_NODES[0];
}

export const WEBSEARCH_NODE = "websearch";
export const CATALOG_RAG_NODE = "potluck-rag";
// Generic Pattern-A federated RAG over SyftHub (any data source). EPFL/Vault are the earlier
// demo-specific nodes, kept so messages persisted by the two-source path still light a node.
export const SYFTHUB_RAG_NODE = "syft-rag";
export const EPFL_RAG_NODE = "syft-epfl";
export const VAULT_NODE = "localculture";
/** The person's own earlier chats. No map node carries this id, so nothing on the map lights. (CUR-4576) */
export const PAST_CHATS_NODE = "past-chats";
export const ROUTER_NODE = "router";
export const SAFETY_NODES = ["safety"] as const;

export const ALL_STACK_NODE_IDS = [
	...MODEL_NODES,
	COMPUTE_NODE,
	WEBSEARCH_NODE,
	CATALOG_RAG_NODE,
	SYFTHUB_RAG_NODE,
	EPFL_RAG_NODE,
	VAULT_NODE,
	ROUTER_NODE,
	...SAFETY_NODES,
] as const;

type RagLike =
	| {
			sources?: RagSource[];
			vaultSynthesis?: string;
	  }
	| null
	| undefined;

/** Map node ids for the RAG engines present in a turn (pipeline order). Admin-authored
 *  community content (`Potluck:Community`) is Potluck-family, so it lights the catalog node. */
export function ragRetrievalNodes(rag: RagLike): string[] {
	const nodes: string[] = [];
	const sources = rag?.sources ?? [];
	if (sources.some((s) => s.engine === "Potluck" || s.engine === "Potluck:Community"))
		nodes.push(CATALOG_RAG_NODE);
	if (sources.some((s) => s.engine === "SyftHub")) nodes.push(SYFTHUB_RAG_NODE);
	if (sources.some((s) => s.engine === "SyftHub:EPFL")) nodes.push(EPFL_RAG_NODE);
	if (rag?.vaultSynthesis?.trim()) nodes.push(VAULT_NODE);
	return nodes;
}

/** Stack node id to flash for a RAG engine label. */
export function ragNodeForEngine(engine: RagEngine): string | undefined {
	if (engine === "Potluck" || engine === "Potluck:Community") return CATALOG_RAG_NODE;
	if (engine === "SyftHub") return SYFTHUB_RAG_NODE;
	if (engine === "SyftHub:EPFL") return EPFL_RAG_NODE;
	return undefined;
}

export function computeRevealStages(
	answer: {
		moderation?: { flagged?: boolean } | null;
		outputModeration?: { flagged?: boolean } | null;
		webSearch?: { sources?: unknown[] } | null;
		rag?: RagLike;
		// A collective second opinion was obtained for this turn — same "verified" test as
		// provenanceFacts.ts (Boolean(verdict || opinions?.length)). This function must stay in step with
		// ProvenanceTrace.svelte's inline revealNodes, which lights ROUTER_NODE for a second-opinion turn:
		// the inline spine and this shared function's staged reveal (StackXRay.svelte) both flash it.
		opinions?: unknown[] | null;
		verdict?: unknown | null;
	},
	opts?: {
		/** The compute node to light, from backendComputeNode(routerMetadata.backend). Omitted → none. */
		computeNode?: string;
		/** The model node to light, from modelNodeFor(servedModelId). Omitted → MODEL_NODES[0]. */
		modelNode?: string;
	}
): string[] {
	// INPUT decline: the turn never reached the model, so it lights ONLY the pre-model safety screen.
	if (answer.moderation?.flagged) return [...SAFETY_NODES];
	const stages: string[] = [];
	if (answer.webSearch?.sources?.length) stages.push(WEBSEARCH_NODE);
	stages.push(...ragRetrievalNodes(answer.rag));
	stages.push(opts?.modelNode ?? MODEL_NODES[0]);
	const pipeline = opts?.computeNode ? [...stages, opts.computeNode] : stages;
	const verified = Boolean(answer.verdict || answer.opinions?.length);
	const withRouter = verified ? [...pipeline, ROUTER_NODE] : pipeline;
	// OUTPUT block: the model DID run (so the retrieval/model pipeline genuinely lit), then the
	// post-generation output screen withheld the answer — append the safety node so the map honestly
	// shows that screen fired. Without this, an output-blocked turn would light the model but never the
	// safety node, mis-claiming the answer was shown.
	if (answer.outputModeration?.flagged) return [...withRouter, ...SAFETY_NODES];
	return withRouter;
}

export function computePulseNodes(opts: {
	declined?: boolean;
	webGrounded?: boolean;
	rag?: RagLike;
	/** The compute node to light, from backendComputeNode(routerMetadata.backend). Omitted → none.
	 *  Mid-stream this is undefined until the gateway's header lands, so the cell lights when we
	 *  know rather than on faith — which is the correct order for a provenance surface. */
	computeNode?: string;
	/** The model node to pulse, from modelNodeFor(servedModelId). Omitted → MODEL_NODES[0]. */
	modelNode?: string;
}): string[] {
	// A declined turn never reached the model — pulse ONLY the pre-model safety screen, never
	// web/model/compute. Client-side web search may have attached sources BEFORE the pre-screen
	// blocked the turn (so `webGrounded` is true), but that grounding was never used. Mirrors
	// computeRevealStages' input-decline branch so the live pulse and the persisted turn-end reveal
	// can never disagree about what ran.
	if (opts.declined) return [...SAFETY_NODES];
	const nodes: string[] = [opts.modelNode ?? MODEL_NODES[0]];
	if (opts.webGrounded) nodes.push(WEBSEARCH_NODE);
	nodes.push(...ragRetrievalNodes(opts.rag));
	if (opts.computeNode) nodes.push(opts.computeNode);
	return nodes;
}

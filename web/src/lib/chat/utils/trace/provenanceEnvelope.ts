// Machine-readable provenance envelope — the agent-facing serialization of an
// assistant turn's honest provenance. The UI reads provenanceFacts() to render chips; this packages
// the SAME facts (+ model identity and serving host) into a stable, documented JSON shape an agent
// consuming the chat can act on programmatically: what model ran, where it ran, whether it searched,
// what it cited, and what the answer actually IS (a real answer vs a self-decline / capability limit
// / clarification — distinct from a safety-layer block). Closed chats
// don't hand a caller honest, structured provenance.
//
// Pure + side-effect-free (reuses provenanceFacts + resolveModelIdentity) so it's unit-testable and
// shared; the API route resolves `serving` once from config and maps each assistant message.

import type { Message } from "$lib/chat/types/Message";
import { provenanceFacts } from "./provenanceFacts";
import { resolveModelIdentity } from "$lib/chat/identity";
import { formatRagEngine } from "$lib/chat/utils/formatRagEngine";
import type { ServingProvenance } from "$lib/chat/servingProvenance";

export const PROVENANCE_SCHEMA = "aipotluck.provenance/v1";

export interface ProvenanceEnvelopeSource {
	/** the inline [n] citation number (RAG/community sources [1..k], open web follows at [k+1..]) */
	n: number;
	title: string;
	url: string | null;
	engine: string;
}

export interface ProvenanceEnvelope {
	schema: typeof PROVENANCE_SCHEMA;
	messageId: string;
	/**
	 * WHO made the model. `id` is the checkpoint that ANSWERED when the gateway reported one
	 * (`routerMetadata.model`, the same per-answer measurement `backend` below uses), and falls back to
	 * the id the conversation REQUESTED when it didn't. `measured` says which you got, because the two
	 * are only equal when nothing substituted — and a substitution is the exact case this field exists
	 * to expose. `id` is the served id, so a substitute lane answering for another model is reported as the substitute (CUR-113).
	 * `measured: false` is not a fault: it means the lane sent no provenance header, which is normal on
	 * some paths. Treat it as unconfirmed, never as a mismatch — reading absence as wrong pages on silence.
	 */
	model: { id: string; name: string; maker: string; openness: string; measured: boolean };
	/**
	 * WHO serves it and on what compute. `provider` is the lane we SEND to (a direct host, or the
	 * routing layer on a sovereign lane) and never the institution that ran the token; `backend` is
	 * that institution, measured per answer from the gateway's own header, absent when the lane does
	 * not report one. Reading `provider` as the compute is the CUR-75 bug.
	 */
	served: { provider: string; sovereign: boolean; checkpoint: string; backend?: string; lane?: string };
	answer: {
		/** "answered" | "self-declined" | "capability-disclaimer" | "clarification" — what it actually IS */
		disposition: string;
		/** a deterministic SAFETY LAYER blocked the turn (the model never ran) — distinct from a model self-decline */
		declinedBySafetyLayer: boolean;
		/** "flagged" | "clear" | "failed-open" | "unknown" — honest pre-screen state */
		screen: string;
		interrupted: boolean;
		/** a pre-vetted starter was served without running the model */
		servedFromCache: boolean;
	};
	grounding: {
		grounded: boolean;
		web: { count: number; engines: string[] };
		rag: { engine: string; label: string; count: number }[];
		vault: boolean;
		/** the citable sources behind inline [n] markers, in citation order */
		sources: ProvenanceEnvelopeSource[];
	};
	/** a collective second opinion (independent open models) cross-checked this answer */
	secondOpinion: boolean;
}

/**
 * Serialize one assistant message's provenance. `modelId` is the conversation's served model; `serving`
 * is resolved once (resolveServing over config) by the caller and shared across the conversation.
 */
export function buildProvenanceEnvelope(
	message: Message,
	modelId: string | undefined,
	serving: Pick<ServingProvenance, "providerLabel" | "isSovereign" | "servedCheckpoint">
): ProvenanceEnvelope {
	const f = provenanceFacts(message);
	// What ANSWERED, not what was asked for. `routerMetadata.model` is measured per turn from the
	// gateway's provenance header — the same source `served.backend` uses below, and the reason that
	// field's comment can honestly say "measured for THIS answer rather than asserted for the
	// deployment". Resolving the identity from `modelId` (the conversation's requested id)
	// would make this envelope structurally unable to report a substitution, with `backend` the only
	// honest field in it. Fall back to the requested id when no header arrived — absent
	// evidence must not read as a mismatch — and publish `measured` so a consumer can tell them apart.
	const servedModelId = message.routerMetadata?.model || modelId;
	const id = resolveModelIdentity(servedModelId);
	const web = message.webSearch?.sources ?? [];
	const rag = message.rag?.sources ?? [];
	// Match the server's citation numbering: community/RAG is numbered first ([1..k]) and open web
	// continues at [k+1..] (see conversation/[id]/+server.ts — RAG startAt=0, web startAt=communityCount).
	// Emitting web-first here would make sources[].n contradict the answer's inline [n] on mixed turns.
	const sources: ProvenanceEnvelopeSource[] = [
		...rag.map((s, i) => ({
			n: i + 1,
			title: s.title,
			url: s.url || null,
			// formatRagEngine so a generic SyftHub source serializes as `SyftHub:<owner/slug>` (the
			// specific source), not the bare `SyftHub` engine — agents get the real provenance.
			engine: formatRagEngine(s),
		})),
		...web.map((s, i) => ({
			n: rag.length + i + 1,
			title: s.title,
			url: s.url || null,
			engine: s.engine,
		})),
	];
	return {
		schema: PROVENANCE_SCHEMA,
		messageId: message.id,
		model: {
			id: servedModelId ?? "",
			name: id.short,
			maker: id.makerShort,
			openness: id.openness,
			measured: Boolean(message.routerMetadata?.model),
		},
		served: {
			provider: serving.providerLabel,
			sovereign: serving.isSovereign,
			checkpoint: serving.servedCheckpoint,
			// The one place in this envelope allowed to name an institution, because it is measured for
			// THIS answer rather than asserted for the deployment.
			backend: message.routerMetadata?.backend,
			// The host the turn was sent to, which tells two lanes with one `backend` apart. (CUR-3193)
			lane: message.routerMetadata?.lane,
		},
		answer: {
			disposition: f.disposition,
			declinedBySafetyLayer: f.declined,
			screen: f.screen,
			interrupted: f.interrupted,
			servedFromCache: f.servedFromCache,
		},
		grounding: {
			grounded: f.grounded,
			web: { count: f.webCount, engines: f.webEngines },
			rag: f.ragHits.map((h) => ({ engine: h.engine, label: h.label, count: h.count })),
			vault: f.vault,
			sources,
		},
		secondOpinion: f.verified,
	};
}

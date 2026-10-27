// ONE definition of "what actually happened this turn", read from the persisted message. Both the inline
// ProvenanceTrace (the 4-step spine) and the sequential request-trace (deriveRequestTrace) consume this,
// so the two surfaces can never disagree about whether a turn was grounded / declined / verified — the
// drift that arises when each derives these booleans independently.
//
// These are message-INTRINSIC facts (no render state like `loading`). A caller that needs "answered now"
// combines `answered` with its own loading flag.

import { backendIsSwiss } from "$lib/chat/servingProvenance";
import { READ_ALOUD_TOOL } from "$lib/chat/readAloudTool";
import type { Message } from "$lib/chat/types/Message";
import type { RagEngine } from "$lib/chat/types/Rag";
import { CATALOG_RAG_NODE, SYFTHUB_RAG_NODE, EPFL_RAG_NODE, PAST_CHATS_NODE } from "$lib/chat/components/stack/reveal";
import {
	detectResponseDisposition,
	type ResponseDisposition,
} from "$lib/chat/utils/responseDisposition";

/** Honest state of the pre-generation safety screen for this turn.
 *  - `flagged`     : toxic-bert / child-safety / content-policy declined the turn.
 *  - `clear`       : a screen ran and raised no flag (we recorded the classifier verdict).
 *  - `failed-open` : the screen could NOT run (no token / unreachable / timeout) and we let the turn
 *                    through — so we must NOT claim it was checked.
 *  - `unknown`     : no screening signal was persisted (e.g. a turn that never reached the server, or
 *                    before the screened-signal was wired). We say "no flag was raised", never "passed". */
export type ScreenState = "flagged" | "clear" | "failed-open" | "unknown";

export interface RagHit {
	engine: RagEngine;
	node: string;
	label: string;
	/** plain-English description of what THIS store actually is — distinct per engine so two
	 *  retrieval steps in the same turn never read as identical (see requestTrace.ts). */
	detail: string;
	count: number;
}

export interface ProvenanceFacts {
	/** the turn was declined by the safety pre-screen (the answer is a decline, the model never ran) */
	declined: boolean;
	/** the model RAN but its answer was withheld by OUTPUT screening (defense-in-depth; the visible
	 *  content is the output-decline, not a real answer). Distinct from `declined` (input, model never ran). */
	withheld: boolean;
	/** honest OUTPUT-screen state — `unknown` when output screening did not run this turn (flag off). */
	outputScreen: ScreenState;
	/** a model wrote answer content: false for an empty turn and for a fixed reply no model wrote */
	answered: boolean;
	/** the generation was interrupted (user stop / stuck-generation watchdog) */
	interrupted: boolean;
	/** the request never reached the server; a pre-vetted starter was served (no model run) */
	servedFromCache: boolean;
	/** the backend that served the answer is on the Swiss allowlist (`backendIsSwiss` on the persisted
	 *  `routerMetadata.backend`). False when no backend was recorded, so a turn proves Swiss compute or
	 *  the claim stays dark (CUR-1883). */
	swissCompute: boolean;
	/** honest pre-screen state (see ScreenState) */
	screen: ScreenState;
	/** open-web search results were attached to this turn (resolved before the server request) */
	webCount: number;
	webEngines: string[];
	/** the open-web search path was engaged for this turn but never cleared the grounding bar (no
	 *  webSearch stamp) — covers BOTH "the gate declined to query the engines" and "a round-trip ran
	 *  and found nothing verified"; lets the trace say something instead of going silent */
	searchAttempted: boolean;
	/** narrower than searchAttempted: true only when an actual round-trip to the open engines ran
	 *  (not just the margin gate considering and declining it) */
	searchRan: boolean;
	/** A web search ran and did not finish (deadline or error), and no web source grounded the (CUR-4091)
	 *  turn, so the answer was written without web results */
	searchFailed: boolean;
	/** RAG stores actually hit, with real counts + their map node */
	ragHits: RagHit[];
	/** a federated vault returned a privacy-filtered synthesis (not a citable doc) */
	vault: boolean;
	/** any grounding at all (web OR rag OR vault) — drives the inline spine's "retrieve" vs "from training" */
	grounded: boolean;
	/** an open HF Space tool (MCP) ran for this turn */
	mcpRan: boolean;
	/** the agent endpoint observed at least one real ACP tool run this turn (write_file, terminal,
	 *  code_execution, etc.) — drives the inline spine's "retrieve" vs "from training" for agent-mode
	 *  turns the same way mcpRan does for open-component turns (CUR-601) */
	agentToolsRan: boolean;
	/** a tool ran that fetched or worked on something for the answer: an open tool other than read-aloud,
	 *  or an agent tool. Read-aloud only speaks the finished answer (CUR-3317). */
	toolLookup: boolean;
	/** this turn actually produced a TTS audio clip (read-aloud ran) — drives the voice-output node so it
	 *  lights only when voice really happened, not on every answer */
	voiced: boolean;
	/** a collective second opinion was obtained (a separate, later opt-in request) */
	verified: boolean;
	/** what the model's answer actually IS — "answered" normally, or an honest non-answer disposition
	 *  (self-declined / capability-disclaimer / clarification) the trace should name rather than let pass
	 *  as a clean answer. Only ever non-"answered" for a real model answer (not a layer decline / cache). */
	disposition: ResponseDisposition;
}

// `satisfies` (not a bare Record<string, …>) makes this EXHAUSTIVE over RagEngine minus the vault:
// adding a future engine without a label here is a compile error, so a new source can't silently
// vanish from provenance aggregation. "SyftHub:Vault" is intentionally excluded — vault synthesis
// is not a citable source (surfaced via `vaultSynthesis`, never as a ragHit).
const RAG_LABEL = {
	Potluck: {
		node: CATALOG_RAG_NODE,
		label: "the Potluck catalog",
		detail: "Searched the committed AI ecosystem index — gap-map categories, exemplar repos, and stack narrative.",
	},
	"Potluck:Community": {
		node: CATALOG_RAG_NODE,
		// Admin team members upload these, not the
		// community, so the label names the team.
		label: "docs the team uploaded",
		detail: "Searched documents the AI Potluck team uploaded to the admin catalog.",
	},
	SyftHub: {
		node: SYFTHUB_RAG_NODE,
		label: "a federated SyftHub source",
		detail: "Queried a federated SyftHub data source live for this turn.",
	},
	"SyftHub:EPFL": {
		node: EPFL_RAG_NODE,
		label: "the EPFL federated store",
		detail: "Queried EPFL's federated news store live for this turn.",
	},
	// No node on the stack map, since the person's own chats are not a component of the stack. (CUR-4576)
	PastChat: {
		node: PAST_CHATS_NODE,
		label: "your past chats",
		detail: "Searched your own earlier chats, because you switched on past-chat search in Settings.",
	},
} satisfies Record<Exclude<RagEngine, "SyftHub:Vault">, { node: string; label: string; detail: string }>;

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

export function provenanceFacts(message: Message): ProvenanceFacts {
	const declined = Boolean(message.moderation?.flagged);
	const withheld = Boolean(message.outputModeration?.flagged);
	const webSources = message.webSearch?.sources ?? [];
	const ragSources = message.rag?.sources ?? [];
	const vault = Boolean(message.rag?.vaultSynthesis?.trim());

	const ragHits: RagHit[] = [];
	for (const [engine, meta] of Object.entries(RAG_LABEL)) {
		const count = ragSources.filter((s) => s.engine === engine).length;
		if (count > 0)
			ragHits.push({
				engine: engine as RagEngine,
				node: meta.node,
				label: meta.label,
				detail: meta.detail,
				count,
			});
	}

	// Screen state: a declined turn is `flagged`. Otherwise we only know more than "no flag" if the
	// pre-screen stamped its verdict (moderation present with screened set) — absent that, `unknown`.
	let screen: ScreenState;
	if (declined) screen = "flagged";
	else if (message.moderation?.screened === true) screen = "clear";
	else if (message.moderation?.screened === false) screen = "failed-open";
	else screen = "unknown";

	// OUTPUT-screen state, mirrored from the parallel `outputModeration` field. `unknown` when output
	// screening did not run this turn (flag off) — the trace then shows no Output-screen step at all,
	// so we never imply the answer was checked when it wasn't.
	let outputScreen: ScreenState;
	if (withheld) outputScreen = "flagged";
	else if (message.outputModeration?.screened === true) outputScreen = "clear";
	else if (message.outputModeration?.screened === false) outputScreen = "failed-open";
	else outputScreen = "unknown";

	const grounded = webSources.length > 0 || ragSources.length > 0 || vault;

	// A fixed reply has text but no model behind it, so it lights no model or compute in X-ray (CUR-2954).
	const answered = Boolean(message.content) && !message.fixedReply;
	// Disposition applies ONLY to a real model answer — never to a safety-layer decline (input `declined`
	// OR output `withheld`, both of which replace the visible content with a decline) or a cache-served
	// starter. Default "answered" everywhere else.
	const disposition =
		answered && !declined && !withheld && !message.servedFromCache
			? detectResponseDisposition(message.content)
			: "answered";

	return {
		declined,
		withheld,
		outputScreen,
		answered,
		interrupted: Boolean(message.interrupted),
		servedFromCache: Boolean(message.servedFromCache),
		swissCompute: backendIsSwiss(message.routerMetadata?.backend),
		screen,
		webCount: webSources.length,
		webEngines: uniq(webSources.map((s) => s.engine)),
		searchAttempted: Boolean(message.searchAttempt),
		searchRan: Boolean(message.searchAttempt?.searched),
		searchFailed: Boolean(message.searchAttempt?.failed) && webSources.length === 0,
		ragHits,
		vault,
		grounded,
		mcpRan: Boolean(message.mcp?.tool),
		agentToolsRan: Boolean(message.agentTools?.toolKinds?.length),
		toolLookup:
			(Boolean(message.mcp?.tool) && message.mcp?.tool !== READ_ALOUD_TOOL) ||
			Boolean(message.agentTools?.toolKinds?.length),
		voiced: Boolean(message.mcp?.audio),
		verified: Boolean(message.verdict || message.opinions?.length),
		disposition,
	};
}

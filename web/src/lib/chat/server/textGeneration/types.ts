import type { ProcessedModel } from "../models";
import type { Endpoint } from "../endpoints/types";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import type { RagContext } from "$lib/chat/types/Rag";
import type { SpeakMode } from "$lib/chat/stores/speakMode";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";
import type { ScreeningFacts } from "./persona";
import type { PreparedTurnMedia } from "$lib/chat/server/chat/prepareTurnMedia";
import type { FaultInjectionName } from "./faultInjection";
import type { LinkedPageState } from "$lib/chat/server/search/linkedUrl";
import type { HarnessPlan } from "$lib/chat/server/harness";
import type { NativeGrounding } from "./nativeTools";

export interface TextGenerationContext {
	model: ProcessedModel;
	endpoint: Endpoint;
	conv: Conversation;
	messages: Message[];
	promptedAt: Date;
	ip: string;
	username?: string;
	/** The primary language subtag the visitor's browser asks for first (`Accept-Language`). (CUR-1713) */
	browserLanguage?: string;
	/** Forwarded to the endpoint as `laneRewrites`; see EndpointParameters. (CUR-2460) */
	laneRewrites?: Record<string, Array<[string, string]>>;
	/** Force-enable multimodal handling for endpoints that support it */
	forceMultimodal?: boolean;
	/** Inference provider preference: "auto", "fastest", "cheapest", or a specific provider name */
	provider?: string;
	/** Optional thinking-effort override forwarded as `reasoning_effort` to OpenAI-compatible endpoints */
	reasoningEffort?: "none" | "low" | "medium" | "high";
	/** Per-model user override for artifacts; wins over the model's supportsArtifacts flag in both directions */
	artifactsOverride?: boolean;
	/** Open-web search grounding for this turn: the numbered evidence block to
	 *  inject into the system prompt, and the date it was retrieved. Set only
	 *  when the user grounded the turn via the composer's web-search toggle. */
	searchContext?: { evidence: string; asOf: string };
	/** True when the turn asks for structurally-LIVE data (live scores/prices/weather/breaking news) the
	 *  open engines can't serve — set by the route from isUnservableLiveQuery. On an UNGROUNDED turn the
	 *  persona then swaps its "offer to search the open web" recency line for an honest "I don't have live
	 *  X" note, so the model doesn't offer the exact search just deemed unable to serve it. */
	unservableLive?: boolean;
	/** On an Auto native turn, whether the embedding gate says the message needs the web (CUR-4083)
	 *  (nativeSearchGate.ts). True forces the first round to web_search. Absent on every other turn. */
	nativeSearchGate?: Promise<boolean>;
	/** Settles once the support classifier has stamped (or not) the reply's moderation. The (CUR-4093)
	 *  titler waits on it so a stamped turn gets the neutral title. Absent on turns the route never screens. */
	supportVerdict?: Promise<boolean>;
	/** What became of a link the person pasted this turn (read as source n, unreadable, or not (CUR-2032)
	 *  opened because search is off). Absent when the message has no qualifying link. */
	linkedPage?: LinkedPageState;
	/** How many sources the person numbered in the message they typed, counted once by the route
	 *  so the prompt note and the server's numbering agree. Read from the typed text, never from attached (CUR-3844)
	 *  documents, whose own reference lists are not the person's sources. */
	visitorSourceCount?: number;
	/** RAG retrieval for this turn (computed in +server.ts before textGeneration). */
	ragContext?: RagContext | null;
	/** Speak mode "always" — LEGACY boolean kept for deploy-skew. Prefer `speakMode`; this is only the
	 *  fallback when `speakMode` is absent (old client). See effectiveSpeakMode in textGeneration. */
	speakAll?: boolean;
	/** Speak preference for this turn (off/auto/always). Authoritative when present: the server derives
	 *  effectiveSpeakMode from it so an explicit "off" suppresses ALL TTS (read-aloud intent, the tool
	 *  router's TTS selection, and speak-all), which `speakAll` alone couldn't express. */
	speakMode?: SpeakMode;
	/** The screening posture the persona states to users, CARRIED from the route's per-turn policy
	 *  (resolveTurnPolicy) so it is source-aware: under guard-primary the input-screen fact tracks the
	 *  guard's own config, not Coop's (guard-swap plan Step 3). Absent (tests, non-route callers) the
	 *  persona derives it from live Coop config exactly as before. */
	screeningFacts?: ScreeningFacts;
	/** The turn's already-settled shared media pass (hydrate → extract → cap, ONCE — Shieldstral
	 *  swap plan Step 3). Set by the route so generation consumes the SAME prepared structure the
	 *  gate screened; absent (tests, non-route callers) preprocessMessages computes it itself. */
	preparedMedia?: PreparedTurnMedia;
	/** CUR-2065 math routing (mathRouting.ts): the code-checked ledger note for the answer model. */
	mathLedgerNote?: string;
	/** The planner found math on a `calculateOnPlannedMath` model's turn, so the answer's first (CUR-4191)
	 *  request forces `calculate` (mathRouting.ts `plannedMathForcesCalculate`). */
	calculateFirst?: boolean;
	/** The turn planner's standalone reading of a follow-up that refers back ("Which ones do (CUR-1957)
	 *  you recommend?"). Sits beside the person's unchanged message, never in place of it. */
	followUpNote?: string;
	locals: App.Locals | undefined;
	abortController: AbortController;
	/** Optional per-turn timing sink. textGeneration writes its generation-phase decomposition here
	 *  (preGenMs/worldModelMs/mcpMs/preprocessMs/hardenMs/genToFirstTokenMs) plus rawFirstTokenMs — the
	 *  model's first RAW token cumulative from promptedAt, the earlier half of the dual first-token stamp.
	 *  Mutated in place at the same one-shot point as the [generation] timing log; the handler folds it
	 *  into the persisted message.timings. Absent ⇒ only the log fires (no behavior change). */
	timings?: TurnSpans;
	/** Called on every raw chunk generate() yields (answer or reasoning, visible or held), before (CUR-4188)
	 *  any buffering, so the route's total cap can tell a model still writing from a stalled one. */
	onModelOutput?: () => void;
	/** Written by a native turn when its answer is finished: what its tool calls retrieved,
	 *  for the route's groundcheck stage, which runs after the output screen. Absent on a scaffolded (CUR-2765)
	 *  turn, whose retrieval the route already holds. */
	nativeGrounding?: NativeGrounding;
	/** Which named fault (if any) this turn should simulate, resolved once by the route via
	 *  faultInjection.ts's resolveFaultInjection BEFORE textGeneration runs — same "computed by the
	 *  route, read here" shape as arithmeticFact above. Only ever non-null in preview/development with (CUR-1614)
	 *  a matching secret header; absent on every real user turn. */
	faultInjection?: FaultInjectionName | null;
	/** When the route's generation watchdog ends this turn (epoch ms), so a retry inside the (CUR-2432)
	 *  answer never starts a wait the turn cannot outlast. Absent ⇒ retries are bounded by attempts only. */
	turnDeadlineAt?: number;
	/** re-attach this turn to the agent task its assistant message already started, rather than (CUR-993)
	 *  submitting a new one. Set by the route only for an attach request on a message that holds one. */
	agentAttach?: { taskId: string; machineId?: string };
	/** Under the `tts_canned_clip` fault, the absolute URL of the canned clip this (CUR-2253)
	 *  deployment serves, built by the route from the request's own origin. Unset otherwise. */
	ttsCannedClipUrl?: string;
	/** Under `tts_slow_canned_clip`, how long the canned clip takes to arrive, so a spec (CUR-3810)
	 *  can tell a reply shown before its audio from one held until the audio exists. */
	ttsCannedClipDelayMs?: number;
	/** The harness this turn runs under, decided once by the route (harness.ts). Absent (CUR-2420)
	 *  means scaffolded, today's turn. */
	harness?: HarnessPlan;
	/** The composer's web search setting, read by a native turn to offer, force or withhold (CUR-2420)
	 *  its search tools. The scaffolded path consumes it in the route instead. */
	webSearchMode?: "off" | "auto" | "always";
}

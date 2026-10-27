import type { InferenceProvider } from "@huggingface/inference";
import type { RagSource } from "./Rag";
import type { SearchSource } from "./Search";
import type { AssistedBy } from "./Message";

export type MessageUpdate =
	| MessageStatusUpdate
	| MessageTitleUpdate
	| MessageStreamUpdate
	| MessageFileUpdate
	| MessageFinalAnswerUpdate
	| MessageReasoningUpdate
	| MessageRouterMetadataUpdate
	| MessageAgentStepUpdate
	| MessageWritePolicyUpdate
	| MessageSafetyUpdate
	| MessageOutputSafetyUpdate
	| MessageInputScreenUpdate
	| MessageSafetyNoticeUpdate
	| MessageNameNoticeUpdate
	| MessageAttachmentNoticeUpdate
	| MessageHistoryNoticeUpdate
	| MessageAgentRouteNoticeUpdate
	| MessageSupportNoticeUpdate
	| MessageFixedReplyUpdate
	| MessageFailoverUpdate
	| MessageRagUpdate
	| MessageWebSearchUpdate
	| MessageSearchAttemptUpdate
	| MessageMcpUpdate
	| MessageAgentToolsUpdate
	| MessageAgentRunUpdate
	| MessageUnrunCodeUpdate
	| MessageAgentConfirmUpdate
	| MessageAgentConfirmResultUpdate
	| MessageCalculationUpdate
	| MessageMcpCallUpdate;

export enum MessageUpdateType {
	Status = "status",
	Title = "title",
	Stream = "stream",
	File = "file",
	FinalAnswer = "finalAnswer",
	Reasoning = "reasoning",
	RouterMetadata = "routerMetadata",
	AgentStep = "agentStep",
	WritePolicy = "writePolicy",
	Safety = "safety",
	OutputSafety = "outputSafety",
	InputScreen = "inputScreen",
	SafetyNotice = "safetyNotice",
	NameNotice = "nameNotice",
	AttachmentNotice = "attachmentNotice",
	HistoryNotice = "historyNotice",
	AgentRouteNotice = "agentRouteNotice",
	SupportNotice = "supportNotice",
	FixedReply = "fixedReply",
	Failover = "failover",
	Rag = "rag",
	WebSearch = "webSearch",
	SearchAttempt = "searchAttempt",
	Mcp = "mcp",
	AgentTools = "agentTools",
	AgentRun = "agentRun",
	UnrunCode = "unrunCode",
	AgentConfirm = "agentConfirm",
	AgentConfirmResult = "agentConfirmResult",
	Calculation = "calculation",
	McpCall = "mcpCall",
}

// Marker on a KeepAlive Status update emitted while "speak every answer" mode synthesizes the answer
// audio (a ZeroGPU round-trip AFTER the text is on screen). The client flips the trace footer to
// "Generating audio…" while it's in flight, instead of a silent pause. Shared server↔client.
export const SPEAK_STATUS = "synthesizing-audio";

// Live phase markers — generalize SPEAK_STATUS. A `phase:<name>` carried on a KeepAlive Status, emitted
// when a turn phase GENUINELY starts (safety gate, retrieval, web search, model thinking), so the live
// request-log can show the ACTUAL current phase instead of one opaque "working…". Like SPEAK_STATUS it's
// a transient signal: dropped from the persisted updates[], read live into a `currentPhase` store. Never
// a fabricated sequence — each marker fires only at its real phase boundary.
export const PHASE_PREFIX = "phase:";
export const phaseMarker = (name: string): string => `${PHASE_PREFIX}${name}`;

// Pre-stream protocol markers (the `x-prestream-events: 1` opt-in — see conversation/[id]/+server.ts).
// When the client opts in, the server returns the streaming Response BEFORE running the pre-stream
// chain (conversation load, rate limits, claim, persist) so its fetch sees headers immediately instead
// of seconds of silence; a long silence would fire the connect-timeout and re-POST a duplicate turn.
// The chain's outcome then arrives IN the stream: `phase:accepted` on success (swallowed by the client's
// vet, never shown), or a Status/Error carrying `statusCode` (+ `conflict` for a duplicate-turn 409) on
// failure — which the client translates back into the exact typed errors the HTTP statuses used to be.
export const PRESTREAM_EVENTS_HEADER = "x-prestream-events";
export const PRESTREAM_STARTING_PHASE = phaseMarker("starting");
export const PRESTREAM_ACCEPTED_PHASE = phaseMarker("accepted");

// A new code sandbox is waiting for a free slot on a full host (agent-service waits up to about a
// minute), and the wait is over. The server holds the turn's deadline while the first is the live phase. (CUR-4584)
export const SANDBOX_WAIT_PHASE = "waiting-sandbox";
export const SANDBOX_READY_PHASE = "sandbox-ready";

// Status
export enum MessageUpdateStatus {
	Started = "started",
	Error = "error",
	Finished = "finished",
	KeepAlive = "keepAlive",
}
export interface MessageStatusUpdate {
	type: MessageUpdateType.Status;
	status: MessageUpdateStatus;
	message?: string;
	statusCode?: number;
	// On a pre-stream 429 from our own message limit: whole seconds until a send can pass (CUR-3216).
	retryAfterSeconds?: number;
	// The picked model's last lane sent nothing before its give-up, so the tab marks it busy. (CUR-4098)
	modelSilent?: boolean;
	// Present only on a pre-stream duplicate-turn failure (statusCode 409, prestream-events protocol):
	// the W2 idempotency info the HTTP 409 body used to carry, so the client can attach to the
	// already-running turn instead of erroring. Mirrors the readGeneration record.
	conflict?: { status?: string; conversationId?: string; messageId?: string };
	// On a layer-test turn's Finished update only, the switches the turn actually applied. (CUR-2139)
	evalLayers?: { promptBlock?: boolean; retrieval?: boolean; maxTokens?: number };
}

// Everything else
/** Which of the four paths in `textGeneration/title.ts` produced the title.
 *
 *  All four can hand back the SAME string — the prompt's first five words — so the title text alone
 *  cannot say whether titling ran. A check on "the title is not the first five words" cannot tell
 *  a deployment with the `conversation-titles` flag off, a model reply that failed `looksLikeTitle`,
 *  a thrown call, and a slow one apart; this field can.
 *
 *  `model` is the only value that asserts a model named this conversation. The other three are the
 *  fallback, and two of them are correct product behaviour rather than a fault. */
export type TitleSource =
	| "model"
	| "titling-disabled"
	| "reply-not-title-shaped"
	| "generation-failed"
	// A fixed neutral title from the catalogs, because the turn carries crisis support. (CUR-4095)
	| "support";

export interface MessageTitleUpdate {
	type: MessageUpdateType.Title;
	title: string;
	source: TitleSource;
}
export interface MessageStreamUpdate {
	type: MessageUpdateType.Stream;
	token: string;
	/** Length of the original token. Used for compressed/persisted stream markers where token is empty. */
	len?: number;
}

export enum MessageReasoningUpdateType {
	Stream = "stream",
	Status = "status",
}

export type MessageReasoningUpdate = MessageReasoningStreamUpdate | MessageReasoningStatusUpdate;

export interface MessageReasoningStreamUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Stream;
	token: string;
}
export interface MessageReasoningStatusUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Status;
	status: string;
}

/**
 * The Reasoning status a turn gets when the server holds the model's untagged reasoning back until its
 * bare `</think>` (ALIA, CUR-3942). It carries no reasoning text, only that reasoning is under way.
 */
export const HELD_REASONING_STATUS = "reasoning-held";

export interface MessageFileUpdate {
	type: MessageUpdateType.File;
	name: string;
	sha: string;
	mime: string;
	/** Set on a file an agent turn wrote; see MessageFile.agentPath. (CUR-4398) */
	agentPath?: string;
}
export interface MessageFinalAnswerUpdate {
	type: MessageUpdateType.FinalAnswer;
	text: string;
	interrupted: boolean;
	/**
	 * The model stopped because it hit its token cap (finish_reason "length"), not because it finished.
	 * A FLAG rather than text in `text`, because the output-moderation path rebuilds the answer body
	 * from screened Stream tokens and discards whatever text a producer put on this update — the same
	 * reason `interrupted` is carried here. The notice itself is appended once, at the update()
	 * chokepoint every producer shares (CUR-149).
	 */
	truncated?: boolean;
	/**
	 * Full output-moderation block: the reviewed decline copy, REPLACING `text` entirely. Carried
	 * out-of-band and applied once at the update() chokepoint, after every model-text guard
	 * (honesty, arithmetic) has already run — the same reason `truncated` is (CUR-149). A decline
	 * is not model output: it must never be regenerated (onGroundedBail), source/hedge-stripped, or
	 * arithmetic-corrected. CUR-946.
	 */
	declineText?: string;
	/**
	 * Mid-stream output-moderation block: the reviewed notice to APPEND to `text` (the already-
	 * cleared, already-honesty-and-arithmetic-processed prefix), after every model-text guard has
	 * run. Out-of-band for the same reason as declineText — the notice itself must never pass
	 * through those guards, even though the prefix ahead of it still should. CUR-946.
	 */
	declineNotice?: string;
}
export interface MessageRouterMetadataUpdate {
	type: MessageUpdateType.RouterMetadata;
	route: string;
	model: string;
	provider?: InferenceProvider;
	// The real backend that served, from `x-litellm-model-api-base` — the only provenance a healthy
	// gateway turn carries (no router header, body echoes the group). Lets a consumer assert WHICH lane
	// answered, which is why the synthetic turn (CUR-89) and the served-identity check (CUR-114/115) need
	// it to survive the pipeline instead of being dropped at the emit gates.
	backend?: string;
	// The host the request was sent to. Two lanes can share a `backend` (the staging router and
	// La Plateforme both report api.mistral.ai), so this is what says which one carried the turn. (CUR-3193)
	lane?: string;
	// The Vercel region of the app server that ran the turn (`VERCEL_REGION`). (CUR-4580)
	appRegion?: string;
	// agent-service's verify tier — "" (unverified) | "execution" | "judge" | "execution+judge".
	// Absent (key not present) means this update carries no opinion on it; present-and-"" is a real,
	// meaningful "checked, unverified" signal. Consumers must branch on presence, not truthiness. (CUR-756)
	verifyMethod?: string;
	// Helper models this turn used, merged by role into routerMetadata.assistedBy. (CUR-984)
	assistedBy?: AssistedBy[];
	// The language the answer was asked for by name (Message.routerMetadata.answerLanguage). (CUR-2237)
	answerLanguage?: string;
}

// Emitted mid-stream by the agent endpoint once per execution step, so the live-stack map can
// beat the Hermes agent node as the agent works. Animation-only: the per-step text already streams in the
// <think> block and the verified answer persists, so this is NOT stamped onto a message field or persisted —
// the client turns it into an `ap:flash` beat on the `hermes` node and the server drops it from the audit log.
export interface MessageAgentStepUpdate {
	type: MessageUpdateType.AgentStep;
	index: number; // 0-based step index
	tool: string; // the step's tool/action name (already redacted by the agent service)
	total?: number; // total planned steps, when known (from the plan event)
}

// Emitted once, early in the agent event stream (same point `plan` fires) once the agent service has
// resolved this caller's write permission for the task (CUR-471). Fires under EVERY
// ACP_PERMISSION_POLICY value — plain `allow`/`deny_writes` report tier "uniform" with null task
// counts; only `staged` populates tasksDone/tasksRequired — but the client only stamps/renders it when
// policy is actually "deny_writes" (see writePolicyProvenance). This is the ONLY signal a caller gets
// for a denied terminal/code_execution request: CUR-217's gating removes those tools from the toolset
// before the session starts rather than denying the call, so there is no tool_result frame to narrate a
// refusal from — unlike write_file/patch denials, which DO get a real tool_result{ok:false}. Carried as
// a structured chunk rather than <think> narration on purpose: agent-service separately injects a
// model-facing prompt note explaining the restriction, and this is meant to stay authoritative
// independent of whatever the model chooses to say.
export interface MessageWritePolicyUpdate {
	type: MessageUpdateType.WritePolicy;
	policy: "allow" | "deny_writes";
	tier: "uniform" | "new" | "trusted";
	tasksDone?: number | null;
	tasksRequired?: number | null;
}

// Emitted when the proactive safety pre-screen (Shieldstral-1.0-3B child/content under
// guard-primary, Coop as the flag-off fallback) declines a message BEFORE the model runs. Carries the marker
// the client stamps onto message.moderation so the answer renders as a safety decline (not a
// model answer) and the live-stack map highlights the safety node. Mirrors the prod app's
// `data-safety`. ("toxicity" is retired as a producer but kept in the union for back-compat.)
export type ModerationKind = "toxicity" | "child_safety" | "content_policy" | "prompt_injection";
export interface MessageSafetyUpdate {
	type: MessageUpdateType.Safety;
	kind: ModerationKind;
	label: string | null;
	score: number;
	// Curated, public-safe label of the Coop rule that declined this turn (server-resolved). Present only
	// when the rule has a reviewed label; the client stamps it onto message.moderation.ruleLabel and shows
	// it in place of the raw `label`. Absent → generic decline copy. Never carries a raw action code.
	ruleLabel?: string;
	// The screen could not run (fail-closed UNKNOWN): the turn was held back unchecked, nothing was
	// flagged. The badge says "not checked" instead of naming a classifier (CUR-2301).
	unscreened?: boolean;
	// A self-harm rule declined the turn; the client stamps message.moderation.support (CUR-2111).
	support?: boolean;
}

// Emitted AFTER generation when OUTPUT screening ran (OUTPUT_MODERATION on) — distinct from
// MessageSafetyUpdate, which is an INPUT pre-screen decline. The screen happens on the model's own answer,
// so this is NOT a "the model never ran" decline; it carries the same verdict the server stamped onto
// message.outputModeration so the live map/trace match the post-reload (persisted) view instead of only
// appearing after a full reload. `flagged` true = the answer was withheld; `screened` records whether the
// output classifier actually ran (false = failed open). `ruleLabel` is the curated rule name (never raw).
export interface MessageOutputSafetyUpdate {
	type: MessageUpdateType.OutputSafety;
	flagged: boolean;
	kind: ModerationKind;
	label: string | null;
	score: number;
	screened?: boolean;
	truncated?: boolean;
	ruleLabel?: string;
	unscreened?: boolean;
	rechecked?: number;
}

// Emitted when the pre-screen returns a NON-BLOCKING safety advisory (Coop "notice" tier) — distinct
// from MessageSafetyUpdate, which is a hard DECLINE that replaces the answer. A SafetyNotice does NOT
// replace anything: the model still runs and answers, and this rides alongside as an honest chip (the
// nameNotice pattern, not the moderation-decline pattern). `message` is the reviewed user-facing line —
// the raw Coop action/category code is never carried to the client. Inert today — see checkAdvisory.
export interface MessageSafetyNoticeUpdate {
	type: MessageUpdateType.SafetyNotice;
	message: string;
}

// Name-adoption correction. Emitted AFTER generation when the runtime guard ($lib/chat/server/nameGuard)
// detects the model adopted a personal name for itself this turn (prompt rules don't reliably stop
// it). Carries the marker the client stamps onto message.nameNotice so an honest "this system has no
// name" chip renders beside the answer, and so the strip can neutralize the name in later context.
export interface MessageNameNoticeUpdate {
	type: MessageUpdateType.NameNotice;
	/** the adopted nickname, when identifiable (for the chip copy) */
	name?: string;
}

// This turn's files were refused because they could not be scanned for known CSAM (no
// scanner configured, or the configured one did not answer). Nothing was stored; the text of the
// turn is still answered, and `message` is the one line both upload paths show. (CUR-2382)
interface MessageAttachmentNoticeUpdate {
	type: MessageUpdateType.AttachmentNotice;
	message: string;
	/** A stored file this turn could not read back, rather than an upload refused (CUR-2382). (CUR-3291) */
	kind?: "unread";
	/** The files left out of the sent message, so its bubble marks them before the reload. (CUR-3405) */
	leftOutFiles?: { name: string; mime: string }[];
}

// The chat was longer than the answering model's context, so this many of its oldest
// exchanges were left out of the request (endpoints/openai/fitHistory.ts). Emitted only when > 0. (CUR-2893)
interface MessageHistoryNoticeUpdate {
	type: MessageUpdateType.HistoryNotice;
	leftOut: number;
}

// Agent was on Auto and the route check failed, so the selected model answered. Emitted
// first thing in the stream; a "direct" verdict emits nothing. (CUR-2830)
interface MessageAgentRouteNoticeUpdate {
	type: MessageUpdateType.AgentRouteNotice;
}

// The input pre-screen let this turn through. Carries the verdict the server stamps onto
// message.moderation, so X-ray on a just-finished answer says whether the check ran, as a reload would.
// `screened` false = the screen could not run and the turn went through unchecked (failed open); absent =
// no verdict was recorded, the same as message.moderation.screened. (CUR-3963)
interface MessageInputScreenUpdate {
	type: MessageUpdateType.InputScreen;
	screened?: boolean;
}

// A self-harm distress rule fired and let the turn through, so the answer leads with the
// Support resources card. Emitted before generation; a declined turn carries `support` on Safety instead. (CUR-3915)
interface MessageSupportNoticeUpdate {
	type: MessageUpdateType.SupportNotice;
	// The message's language when the multilingual support signal stamped the card, for its copy. (CUR-4093)
	supportLang?: string;
	// The country the message places the person at risk in, for the card's helpline page. (CUR-4488)
	supportCountry?: string;
	// The public label of the distress rule that matched, for X-ray's rule list. (CUR-3915)
	ruleLabel?: string;
}

// This turn's text is a fixed string the server wrote, not a model reply, so no model ran.
// Emitted before the FinalAnswer; the client stamps message.fixedReply so the receipt says so instead
// of a provenance trace for a pipeline that never ran. (CUR-1579)
interface MessageFixedReplyUpdate {
	type: MessageUpdateType.FixedReply;
	kind: FixedReplyKind;
}

// "capacity": output screening's phase deadline tripped before any model token arrived, so the reply
// is the at-capacity notice (screenStream.ts). No model wrote it, so the footer must not read "from
// training" beside it.
// "missing-document": the turn names a document nobody attached or pasted, so the server answers with a
// fixed note and no model call (missingDocument.ts, CUR-1835, stamped since CUR-2124).
// "canned": the `canned_reply` fault's stand-in answer for a spec that checks only our UI (SOL-91, CUR-2954).
export type FixedReplyKind = "low-resource-language" | "capacity" | "missing-document" | "canned";

// The primary model did not answer this turn and a backup lane serving a different model took
// over (endpoints/failover.ts). Emitted before the backup's attempt starts, so the live log can show the
// switch as it happens and the receipt can keep it; the badge alone names only the model that answered. (CUR-2239)
interface MessageFailoverUpdate {
	type: MessageUpdateType.Failover;
	/** the primary model's id, the one the backup stood in for */
	from: string;
	/** the backup lane's served-model id */
	to: string;
	reason: FailoverReason;
	/** why the lane before the backup gave up; absent when no attempt was made (CUR-3313) */
	cause?: FailoverCause;
}

// "unavailable": the primary was tried and produced no output within its retry budget.
// "skipped": the primary_lane_down fault took it out before any attempt (preview testing only).
export type FailoverReason = "unavailable" | "skipped";

// What the last attempt at the lane before the backup ended with (endpoints/failover.ts failoverCause).
// "no-first-chunk": the failover deadline ran out with the lane silent. "rate-limited": a 429.
// "empty-completion": the lane finished with no tokens. "http-<status>": any other HTTP error.
// "error": a failure with no status (network, abort, a thrown bug).
export type FailoverCause =
	| "no-first-chunk"
	| "rate-limited"
	| "empty-completion"
	| `http-${number}`
	| "error";

// Emitted when the auto-router retrieved RAG context for this turn (catalog, federated
// EPFL, and/or vault synthesis). Carries the provenance the client stamps onto
// message.rag so the trace + map highlight appear during streaming, not only after reload.
export interface MessageRagUpdate {
	type: MessageUpdateType.Rag;
	query: string;
	sources: RagSource[];
	asOf: string;
	vaultSynthesis?: string;
}

// Emitted when the chat handler ran open-web search server-side for this turn (community-first: AFTER
// RAG, so its sources are numbered [k+1..]). Carries the provenance the client stamps onto
// message.webSearch so the citations strip + map highlight appear during streaming, not only after
// reload — exactly mirroring MessageRagUpdate. Web search runs in-handler so it can be sequenced
// after community sources — see runSearch.ts.
export interface MessageWebSearchUpdate {
	type: MessageUpdateType.WebSearch;
	query: string;
	sources: SearchSource[];
	asOf: string;
}

// Emitted when the chat handler engaged the open-web search path for this turn (the margin gate
// ran, or mode was "always") but the turn never ended up grounded — either the gate declined to
// even query the engines, or a round-trip ran and no result cleared the relevance bar. The
// MessageWebSearchUpdate above is never emitted in this case (no stamp without sources). Without
// this, a search that was visibly considered (LiveRequestLog's "Searching the open web…" phase)
// vanishes with no record once the turn lands, and the trace reads identically to "no search
// considered at all". Carries no query/source text — once we know the search didn't ground the
// turn, there's nothing else worth persisting beyond `searched` (which of the two sub-cases it was).
export interface MessageSearchAttemptUpdate {
	type: MessageUpdateType.SearchAttempt;
	grounded: false;
	searched: boolean;
	/** The search ran and did not finish (see Message.searchAttempt.failed). (CUR-4091) */
	failed?: "timeout" | "error";
}

// The answer model called the native `calculate` tool and code evaluated the expression it
// sent (endpoints/openai/calculateTool.ts). One update per call. The UI shows the expression beside the
// result so the reader can check the setup; it never says "checked" or "verified", because a right sum
// of a wrong setup is still a wrong answer. `error` is set instead of `result` when the expression
// could not be evaluated; the model was told why and answered on. (CUR-2273)
export interface MessageCalculationUpdate {
	type: MessageUpdateType.Calculation;
	expression: string;
	result?: string;
	error?: string;
	counts?: string;
}

// One call to an operator-configured MCP server (mcp/serversKit.ts), for the step-by-step
// trace and provenance. Names and an outcome only, except for the conversation's own sandbox
// (CUR-4232), whose code and output the person sees in place of a confirmation card. (CUR-3026)
export interface MessageMcpCallUpdate {
	type: MessageUpdateType.McpCall;
	server: string;
	tool: string;
	/** ok | tool_error | failed | input_required | declined | timeout | capped | unknown_tool */
	outcome: string;
	ms: number;
	/** The code or command a sandbox call ran, clipped. */
	input?: string;
	/** What it printed, clipped. */
	output?: string;
}

// Emitted when an MCP open component (an open HF Space tool, e.g. TTS / image gen) ran for this turn.
// Unlike search/RAG — which run in the POST handler BEFORE generation and stamp the message there — the
// MCP pre-pass runs inside textGeneration, so its provenance arrives as a streamed update. Carries the
// tool name the reducer (server) and the page loop (client) stamp onto message.mcp, so the provenance
// trace reads "open component · <tool>" instead of "from training", live during streaming and on reload.
export interface MessageMcpUpdate {
	type: MessageUpdateType.Mcp;
	tool: string;
	/** Origin of the Space that ran (for the "see the component" link in the trace). */
	space?: string;
	/** The produced audio clip's URL, when the component made one (TTS). The client autoplays THIS via an
	 *  off-DOM Audio object — stable against the markdown renderer swapping the visible <audio> mid-play. */
	audio?: string;
	/** Honesty: a tool was ATTEMPTED but abandoned because the open Space didn't respond in time (cold
	 *  start). We surface the skip instead of silently answering tool-less, so intermittent tool usage is
	 *  legible to the user/tester rather than looking random. `skipMs` is how long we waited. */
	skipped?: boolean;
	skipMs?: number;
	/** With `skipped`: the tool answered, with an error (CUR-2645), rather than not answering in time. */
	failed?: boolean;
	/** With `skipped`: read-aloud has no voice for the answer's language (CUR-3151); its English name. */
	unsupportedLanguage?: string;
	/** With `unsupportedLanguage`: the English-voice clip, played only on the visitor's request (CUR-3989). */
	fallbackAudio?: string;
	/** With `audio`: the voice's accent when the language has regional variants (CUR-3989). */
	voice?: string;
}

// Emitted from the agent endpoint's `done` handler when the ACP tool-call stream observed at least one
// real tool run this turn (write_file, terminal, code_execution, etc. — the same `toolKinds` set
// `wroteCodeWithoutRunningIt`/`claimedStepsWithoutObservedTools` already read for the unrun-code caveat).
// Only emitted when non-empty — an empty toolKinds is ambiguous (CUR-234: could mean "ACP off, correctly
// silent" or "the agent genuinely used no tools"), so this stays silent rather than assert a negative.
// Carries the marker the client stamps onto message.agentTools so the provenance trace reads "ran tools ·
// <kinds>" instead of falling through to "from training" on a turn that genuinely ran real tools.
export interface MessageAgentToolsUpdate {
	type: MessageUpdateType.AgentTools;
	toolKinds: string[];
	// per-kind call counts, alongside the distinct-kind toolKinds list above — powers the
	// "Edited 2 files, ran 1 command" summary line instead of a flat kind join. Optional so an update
	// built before this field existed still type-checks. (CUR-775)
	counts?: Record<string, number>;
}

// The agent-service task id this turn submitted, and the Fly machine holding its state. The run
// outlives the request, so the message keeps the handle a later visit needs to re-attach to it. (CUR-993)
interface MessageAgentRunUpdate {
	type: MessageUpdateType.AgentRun;
	taskId: string;
	machineId?: string;
	closed?: boolean;
}

// Why a turn's output is predicted rather than measured. The first three are this endpoint's own read of
// the ACP tool-call stream; the last two are agent-service's own `unrun_detail` verdict on a turn whose
// answer it never got to re-check. `service-verdict-structural` is separated from the rest because it is
// a different claim — the run tried and did not finish, rather than the agent overclaiming what it did —
// and the two already get different answer-prefix copy (STRUCTURAL_FAILURE_NOTICE vs UNRUN_CODE_NOTICE).
export type UnrunCodeReason =
	| "wrote-not-run"
	| "claimed-not-observed"
	| "continued-session-no-action"
	| "service-verdict"
	| "service-verdict-structural";

// The negative half of MessageAgentToolsUpdate above, and it exists precisely because that update cannot
// carry it. `agentTools` stays silent on an empty toolKinds by design (CUR-234), so its ABSENCE is
// ambiguous between "ACP off, correctly silent" and "the agent genuinely executed nothing" — a client
// reading "nothing ran" out of that absence would assert exactly the negative that comment refuses to.
//
// This asserts it positively, from the one place that can tell the two apart: endpointAgent's own
// unrun-code check, which already decides whether to prepend UNRUN_CODE_NOTICE to the answer. Emitted on
// exactly the turns that prose fires on and no others, so the reasoning panel's header and the sentence
// directly beneath it cannot disagree. The header's "Computing…"/"Computed" label tracks whether the
// block finished STREAMING and nothing else, so it cannot say that a turn which wrote files ran none
// of them.
export interface MessageUnrunCodeUpdate {
	type: MessageUpdateType.UnrunCode;
	reason: UnrunCodeReason;
}

// Emitted mid-run when agent-service pauses a tool call on ACP_PERMISSION_POLICY=confirm and needs a
// human answer (CUR-218 — "the confirmation IS the security boundary, so it must be legible", CUR-54).
// `taskId` names which agent-service task the eventual allow/deny click resolves (the agent-confirm
// route has no other way to find it); `confirmId` names which of that task's paused calls. `kind`/
// `title`/`summary` are agent-service's own redacted description of the call (acp_client.py's
// _describe_tool_call) — never raw tool input/output. Accumulates onto message.agentConfirmations
// rather than replacing a single field, since one turn can pause more than once.
export interface MessageAgentConfirmUpdate {
	type: MessageUpdateType.AgentConfirm;
	taskId: string;
	confirmId: string;
	kind: string;
	title: string;
	summary: string;
	/** Auto mode's one plain sentence for what the call does. When present the card leads (CUR-3142)
	 *  with it and keeps the raw title/summary behind "Details". */
	plain?: string;
	/** Epoch ms this confirmation auto-denies at (agent-service's own confirm_timeout_secs,
	 *  stamped into an absolute deadline at the point this server received the ACP frame — the two
	 *  processes don't share a clock, so agent-service never sends an epoch itself). Absent on an (CUR-1094)
	 *  older/coarse build that predates this field; the UI falls back to its old static copy. */
	deadlineAt?: number;
	/** "mcp" when this asks before an MCP tool runs; the answer goes to the elicitation route, (CUR-3026)
	 *  not agent-confirm. Absent for agent-service's gates. */
	channel?: "agent" | "mcp";
}

// Emitted when a pause opened by MessageAgentConfirmUpdate resolves — a real human answer, a timeout
// (agent-service fails CLOSED: reason "timeout" always pairs with decision "deny"), or the task being
// canceled out from under it. Matched to the open entry by `confirmId`.
export interface MessageAgentConfirmResultUpdate {
	type: MessageUpdateType.AgentConfirmResult;
	confirmId: string;
	decision: "allow" | "deny" | "canceled";
	reason: string;
}

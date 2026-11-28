import type OpenAI from "openai";
import type { FailoverCause, FailoverReason } from "$lib/chat/types/MessageUpdate";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message, MessageFile } from "$lib/chat/types/Message";
import type {
	TextGenerationStreamOutput,
	TextGenerationStreamToken,
	InferenceProvider,
} from "@huggingface/inference";
import type { Model } from "$lib/chat/types/Model";
import type { ObjectId } from "bson";
import type { ReplayMode } from "./openai/modelReplay";

// The endpoint type surface lives in this leaf module (no local imports) so the endpoint
// implementations (openai/, agent/) can depend on it without importing the endpoints.ts
// registry — which imports them back. Keeping the types here breaks that import cycle.

export type EndpointMessage = Omit<Message, "id"> & {
	/** A user turn's attached clipboard and document text, already inside `content`; set by
	 *  preprocessMessages. The agent endpoint keeps it whole for earlier turns. */
	attachedText?: string;
};

// parameters passed when generating text
export interface EndpointParameters {
	messages: EndpointMessage[];
	preprompt?: Conversation["preprompt"];
	generateSettings?: Partial<Model["parameters"]>;
	isMultimodal?: boolean;
	conversationId?: ObjectId;
	/** An agent task this message already started, to re-attach to instead of submitting a new
	 *  one. Only the agent endpoint reads it. `handoff` is what the run was submitted with. */
	agentAttach?: { taskId: string; machineId?: string; handoff?: boolean };
	/**
	 * The answer language the person fixed in settings, as an `ANSWER_LANGUAGES` code
	 * (answerPreferences.ts), or unset when the answer follows the question. The chat prompts carry it
	 * themselves; the agent endpoint, which ignores `preprompt`, reads this to word its own preamble.
	 */
	replyLanguage?: string;
	locals: App.Locals | undefined;
	abortSignal?: AbortSignal;
	/** Inference provider preference: "auto", "fastest", "cheapest", or a specific provider name */
	provider?: string;
	/** Optional thinking-effort, forwarded as OpenAI `reasoning_effort` when set */
	/**
	 * `reasoning_effort` on the wire. "none" and "minimal" are not decoration: on the compare
	 * lane, a reasoning model at a small max_tokens can spend the whole budget on reasoning and return
	 * no answer, and "none" turns that into an answer with no reasoning. Turning thinking off is the
	 * only way some models can answer inside a bounded budget.
	 */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
	/**
	 * When true the request carries `thinking: {type: "disabled"}`, which GLM honours. On the
	 * HF-router GLM-5.2 lane `reasoning_effort: "none"` is ignored: at a tiny max_tokens, reasoning
	 * still takes the budget and content can come back empty, while this field returns the answer with
	 * finish_reason "stop". Only set it on a call pinned to a model known to accept it; other lanes
	 * may reject the unknown field.
	 */
	disableThinking?: boolean;
	/**
	 * When true a call to the LiteLLM gateway carries its per-request cache opt-out, so a repeated
	 * identical request reaches the model again instead of returning the cached answer. For a caller
	 * that samples one request several times and votes (the RAG entity-scope guard). Other
	 * hosts get nothing (`gatewayNoCache`).
	 */
	skipGatewayCache?: boolean;
	/**
	 * Is this call generating the ANSWER the user reads, as opposed to a side-call (title, search
	 * decision, query rewrite, world-model verifier, second-opinion panelist)? Only the answer path
	 * sets it; `generateFromDefaultEndpoint` — which is every side-call — leaves it unset.
	 *
	 * The one consumer is the sovereign-compute assertion in endpointOai: the copy claims Switzerland
	 * for the compute that wrote the answer, and the panel deliberately fans out to models hosted
	 * outside the allowlist. See `sovereignCopyFalsifiedBy`. Unset reads as "not the answer", which is
	 * the safe direction — a missed side-call logs nothing, a missed answer would log a falsehood.
	 */
	servesUserAnswer?: boolean;
	/**
	 * Told how many old exchanges were left out to fit the lane's context, on every lane
	 * invocation that fits the history, so a backup lane's own count replaces the primary's.
	 */
	onHistoryFitted?: (leftOut: number) => void;
	/**
	 * What to change in this request when a backup lane serving a DIFFERENT model takes the turn, keyed
	 * by that lane's model id. Each pair is [text written for the primary, the same text
	 * written for the backup]: the persona and the per-turn provenance facts, both of which say "You are
	 * <model>". Without it a backup-served answer can introduce itself as the primary model. Exact substrings this app generated, so nothing else in the prompt is touched.
	 */
	laneRewrites?: Record<string, Array<[string, string]>>;
	/**
	 * The last user turn as the person wrote it, before `hardenLastUserTurn` rewrote it into the
	 * grounding preamble plus a fence. The agent endpoint sends this as its task. Given the hardened
	 * turn instead, the agent can answer a question it cannot read by reciting the preamble's decline
	 * rule. Unset on side-calls, which never harden.
	 */
	unhardenedUserText?: string;
	/**
	 * Stores files an agent turn produced with this conversation (My files, or the files table
	 * when the bucket is off for this person) and returns one reference per file, in order. Only the
	 * answer path sets it; the agent endpoint calls it while the agent's workdir still holds the files.
	 */
	saveAgentFiles?: (files: File[], opts?: { turn?: string }) => Promise<MessageFile[]>;
	/**
	 * The system text the visitor wrote for this turn: Personalization when on, else the conversation's
	 * own preprompt unless it is the model's (`clientAuthoredInstructions`). The agent endpoint puts it in
	 * its task prompt, since `preprompt` there also carries the chat persona it must not get.
	 */
	clientInstructions?: string;
	/**
	 * The `primary_lane_down` fault: withFailover treats the first lane as failed, so the
	 * answer comes from the backup lane. Only ever set on a preview/development turn that carried the
	 * fault-inject secret; see textGeneration/faultInjection.ts.
	 */
	failPrimaryLane?: boolean;
	/**
	 * The `primary_lane_hangs` fault: the first lane accepts the call and never sends headers, which is
	 * what a stalled gateway looks like from here. Unlike `failPrimaryLane` nothing is
	 * thrown, so it exercises the path where only a deadline can move the turn to the backup. Same
	 * preview/development-only gate.
	 */
	hangPrimaryLane?: boolean;
	/**
	 * The `every_lane_hangs` fault: every lane accepts the call and never sends headers, so
	 * no backup can answer and the turn ends on the last lane's give-up, as a model that stays silent
	 * on every host does. Same preview/development-only gate.
	 */
	hangEveryLane?: boolean;
	/**
	 * The `primary_lane_rate_limited` fault: the first lane throws the SDK's 429 on every
	 * attempt, inside withFailover, so a turn shows what happens after a real over-cap answer. Same
	 * preview/development-only gate.
	 */
	rateLimitPrimaryLane?: boolean;
	/**
	 * The `primary_stream_errors_once` fault: the first call to the first lane opens, sends its
	 * provenance report and then throws the 500 a gateway's in-band `finish_reason: error` becomes, so a
	 * turn shows whether the lane is asked again before any text. Same preview/development-only gate.
	 */
	failStreamOnce?: boolean;
	/**
	 * The `every_lane_rate_limited` fault: every lane of the model throws the SDK's 429 before
	 * any request leaves, the way a host whose account has spent its budget answers every call. The warm
	 * probe uses it to show the busy mark set with no visitor turn. Same preview/development-only gate.
	 */
	rateLimitEveryLane?: boolean;
	/**
	 * The `every_lane_payment_required` fault: every lane throws the 402 a host sends when it
	 * will not bill the call, before any request leaves. Same preview/development-only gate.
	 */
	paymentRequiredEveryLane?: boolean;
	/**
	 * The `tool_round_rate_limited` fault: the tool loop's first request after round 1 throws
	 * the SDK's 429 once, so a spec sees a later round retry on the same lane. Same
	 * preview/development-only gate.
	 */
	rateLimitToolRound?: boolean;
	/**
	 * The `tool_round_rate_limited_sustained` fault: every tool-loop request after round 1 on
	 * the first lane throws the SDK's 429, so the same-lane retries run out and the turn hands its
	 * transcript to the backup lane. Same preview/development-only gate.
	 */
	rateLimitToolRoundSustained?: boolean;
	/**
	 * A tool loop the lane before this one started and could not finish: its transcript,
	 * tool results included, and the round it reached. Set only by withFailover on a backup lane, which
	 * continues the loop from here rather than starting the turn again, so no tool runs twice.
	 */
	toolTranscript?: { messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]; round: number };
	/**
	 * The `wrong_model_served` fault: every response body on the first lane names this model
	 * while its headers still name the requested one, the swap servedModelPeek.ts detects. A backup
	 * lane answers clean. Same preview/development-only gate.
	 */
	substituteServedModel?: string;
	/**
	 * The `model_replay` faults: the answer's model calls are served from a recording
	 * when one matches (endpoints/openai/modelReplay.ts). On a miss, `new_episodes` calls the model and
	 * records it, and `none` fails the call. Same preview/development-only gate.
	 */
	replayModelCalls?: ReplayMode;
	/**
	 * When the route's generation watchdog ends the turn (epoch ms). A retry whose wait would leave the
	 * answer no time before it is not taken (endpoints/retryPolicy.ts). Unset on side calls.
	 */
	turnDeadlineAt?: number;
	/**
	 * The latest the turn can run to (epoch ms), read when called: the route's ceiling for a turn still
	 * working, which is longer once the turn has searched. The native tool loop stops offering tools once
	 * the answer round would no longer fit before it (endpoints/openai/answerRoundBudget.ts). Unset on side calls.
	 */
	turnCeilingAt?: () => number;
	/** Continue: the visible text of an answer cut off at the time limit, which this turn finishes. */
	continueFrom?: string;
	/**
	 * Offer the native `calculate` tool on this request (endpoints/openai/calculateTool.ts).
	 * Decided once per turn by textGeneration (flag + the model's supportsTools) so the persona's
	 * calculate paragraph and the tool always travel together. Only the openai chat endpoint reads it,
	 * and only on the answer (`servesUserAnswer`).
	 */
	calculateTool?: boolean;
	/** With `calculateTool`, the first request forces `calculate`: the turn planner found math, and the
	 *  model's row sets `calculateOnPlannedMath`. */
	calculateFirst?: boolean;
	/**
	 * The tools a native answer is offered (textGeneration/nativeTools.ts). Takes the
	 * place of `calculateTool` when set; the openai chat endpoint runs them in the same streamed tool loop.
	 */
	nativeTools?: NativeToolKit;
}

/** A tool call as it arrived on the stream, arguments still a JSON string. */
export type StreamedToolCall = { id: string; name: string; arguments: string };

/** What one executed tool call returns: the text the model reads back, and what the UI shows. */
export interface NativeToolResult {
	/** The tool message content the model reads. */
	content: string;
	calculation?: { expression: string; result?: string; error?: string; counts?: string };
	/** Every web source found so far this turn, numbered, so the client can replace its stamp. */
	webSearch?: NonNullable<Message["webSearch"]>;
	/** Every catalog source found so far this turn, numbered after or before the web ones as they came. */
	rag?: NonNullable<Message["rag"]>;
	/** One call to an operator-configured MCP server, for the trace. `input` and `output` are set only
	 *  for a server whose work the person sees (serversKit `shownServers`). */
	mcpCall?: { server: string; tool: string; outcome: string; ms: number; input?: string; output?: string };
	/** This web_search ran and did not finish (deadline or error), so the note under the answer can
	 *  say so. */
	searchFailed?: "timeout" | "error";
	/** This web_search finished and found no source worth citing, so the note under the answer can say
	 *  the answer rests on the model alone. Not set when the search did not finish (`searchFailed`). */
	searchEmpty?: true;
}

/** The tools offered on one answer: their OpenAI definitions and one executor for any call. */
export interface NativeToolKit {
	definitions: { type: "function"; function: { name: string; description: string; parameters: object } }[];
	/** Never throws: a failure comes back as content the model can read and answer around. */
	run(call: StreamedToolCall): Promise<NativeToolResult>;
	/** What this kit's calls show while they are still running (a sandbox waiting for a slot).
	 *  The tool loop yields each frame as it arrives. A wrapper that spreads the kit keeps it. */
	frames?: ToolFrames;
	/** A tool the first round must call (a pasted link's read_page), otherwise the model picks. */
	firstRoundTool?: string;
	/** Calls the server runs itself before round 1 (a search the gate or the composer's "always"
	 *  asks for). The loop treats them as a round the model already made, so their sources reach the UI and
	 *  the transcript the way a model's call would, and round 1 goes out with `tool_choice: "auto"`. */
	firstRoundCalls?: StreamedToolCall[];
	/** Label for logs, e.g. "calculate" or "native". */
	label: string;
	/** Tool rounds this kit's answer may run. Absent: MAX_CALCULATE_ROUNDS. */
	maxRounds?: number;
	/** Run a round's calls one after another, in the order the model gave them, for tools that share
	 *  state (the sandbox's workspace). Absent: the round's calls run at once. */
	sequential?: boolean;
	/** What a round of these calls retrieves, for the live line shown while it runs. */
	retrievalOf?(calls: StreamedToolCall[]): ToolRetrieval | undefined;
	/** Runs before a round's calls, in order, and may wait on the person (a confirmation for an
	 *  MCP tool that can change something). What it yields goes to the UI as it happens. */
	beforeRun?(
		calls: StreamedToolCall[]
	): AsyncGenerator<Pick<TextGenerationStreamOutputSimplified, "agentConfirm" | "agentConfirmResult">, void, void>;
}

/** What a running tool call may show before it returns. */
export type ToolRunFrame = Pick<TextGenerationStreamOutputSimplified, "sandboxWait" | "searchProgress">;

/** The frames a kit's running calls push, for the tool loop to read while they run (toolFrames.ts). */
export interface ToolFrames {
	push(frame: ToolRunFrame): void;
	/** Every frame pushed since the last take, oldest first. */
	take(): ToolRunFrame[];
	/** Resolves once a frame is waiting to be taken. */
	next(): Promise<void>;
}

/** The retrieval a tool round runs: the web, our own documents, or both. */
type ToolRetrieval = "web" | "documents" | "documents-web";

export type TextGenerationStreamOutputSimplified = TextGenerationStreamOutput & {
	token: TextGenerationStreamToken;
	/** Set only on the announcement withFailover yields before a cross-model backup lane. */
	failover?: { from: string; to: string; reason: FailoverReason; cause?: FailoverCause };
	/** The model ended this request with tool calls (only when the request offered a tool).
	 *  Consumed by withToolLoop; never reaches generate.ts. */
	toolCalls?: { id: string; name: string; arguments: string }[];
	/** A tool round is about to retrieve this, so the live line can say what is running. */
	toolRetrieval?: ToolRetrieval;
	/** A code sandbox started waiting for a slot on a full host, or that wait ended. */
	sandboxWait?: "waiting" | "ready";
	/** One web search started or came back (MessageSearchProgressUpdate's fields). */
	searchProgress?: { n: number; sources?: number; failed?: boolean };
	/** The calculate calls code just evaluated, one per call, for the UI. */
	calculations?: { expression: string; result?: string; error?: string; counts?: string }[];
	/** One tool round's cost, evaluation through the next request's headers. */
	calculateToolMs?: number;
	/** The share of calculateToolMs spent running the tools (the search), not on the next request. */
	toolRunMs?: number;
	/** Sources a native tool call found, cumulative for the turn, for the UI and the record. */
	toolSources?: Pick<NativeToolResult, "webSearch" | "rag" | "searchFailed" | "searchEmpty">;
	/** The MCP server calls a tool round made, for provenance and the trace. */
	mcpCalls?: NonNullable<NativeToolResult["mcpCall"]>[];
	routerMetadata?: {
		route?: string;
		model?: string;
		provider?: InferenceProvider;
		backend?: string;
		// The host the request was sent to (a gateway, an adapter, or the vendor itself).
		lane?: string;
		// agent-service's verify tier for this turn — "" (unverified) | "execution" | "judge" |
		// "execution+judge". Optional-and-absent (key not present) means "no signal this frame", distinct
		// from "" which is a real, meaningful value ("checked and found unverified"). Consumers must use
		// presence checks (`"verifyMethod" in ...`), never `||`, or the real "" signal gets treated as
		// absence and silently dropped.
		verifyMethod?: string;
	};
	writePolicy?: {
		policy?: string;
		tier?: string;
		tasksDone?: number | null;
		tasksRequired?: number | null;
	};
	agentTools?: { toolKinds: string[]; counts?: Record<string, number> };
	/** The agent-service task this turn submitted, and the machine it runs on. Stored on the
	 *  message so a later visit can re-attach to a run the tab that started it no longer watches. */
	agentRun?: { taskId: string; machineId?: string; closed?: boolean; handoff?: boolean };
	/** On the terminal chunk: the turn stopped reading a run that is still going and handed it to the page,
	 *  which re-attaches to it (deadlineLadder.ts agentHandoffAt). The answer is stored interrupted. */
	agentHandoff?: boolean;
	/** A file the agent wrote this turn, saved with the conversation. `agentPath` is its path in
	 *  the agent's workdir, the name the reply's download link carries. */
	agentFile?: { name: string; sha: string; mime: string; agentPath: string; agentTurn?: string };
	/** agent-service opened a confirmation gate mid-run (ACP_PERMISSION_POLICY=confirm) and is
	 *  paused waiting for a human answer. `taskId` is required to resolve it — the agent-confirm route
	 *  has no other way to name which agent-service task the click belongs to. */
	agentConfirm?: {
		taskId: string;
		confirmId: string;
		kind: string;
		title: string;
		summary: string;
		/** Epoch ms this confirmation auto-denies at, stamped from agent-service's own
		 *  confirm_timeout_secs at the point this process received the frame (see endpointAgent.ts) — not
		 *  an agent-service timestamp, since the two clocks aren't the same clock. Absent on an older/coarse
		 *  frame shape that carries no timeout_secs. */
		deadlineAt?: number;
		/** "mcp" when the question is an MCP tool confirmation, answered through the
		 *  elicitation route; absent for agent-service's own gates. */
		channel?: "agent" | "mcp";
		/** Auto mode's one plain sentence about the call; the card leads with it. */
		plain?: string;
	};
	/** The confirmation above resolved — by a human's answer, a timeout (fails CLOSED to
	 *  "deny"), or the task being canceled out from under it. */
	agentConfirmResult?: {
		confirmId: string;
		decision: "allow" | "deny" | "canceled";
		reason: string;
	};
};

// type signature for the endpoint
export type Endpoint = (
	params: EndpointParameters
) => Promise<AsyncGenerator<TextGenerationStreamOutputSimplified, void, void>>;

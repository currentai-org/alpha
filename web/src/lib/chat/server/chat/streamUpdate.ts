import {
	MessageUpdateStatus,
	MessageUpdateType,
	MessageReasoningUpdateType,
	PHASE_PREFIX,
	phaseMarker,
	SANDBOX_WAIT_PHASE,
	type MessageUpdate,
	type MessageStreamUpdate,
} from "$lib/chat/types/MessageUpdate";
import type { Message } from "$lib/chat/types/Message";
import { mergeRouterMetadata } from "$lib/chat/utils/routerMetadata";
import type { Metrics } from "$lib/chat/server/metrics";
import {
	mcpProvenance,
	writePolicyProvenance,
	agentToolsProvenance,
	unrunCodeProvenance,
	agentConfirmOpened,
	agentConfirmResolved,
	calculationAppended,
	mcpCallAppended,
	ragProvenance,
	searchProvenance,
} from "$lib/chat/messageProvenance";

/**
 * The per-turn event reducer, lifted out of the conversation POST handler's stream `start()` closure.
 *
 * `applyMessageUpdate` is the 10-way dispatch on `event.type` that folds each streamed
 * MessageUpdate into the assistant message (`content`, `reasoning`, `files`, `routerMetadata`,
 * the audit `updates[]` log) and records model metrics. It is deliberately free of the stream
 * controller, the DB handle, and `conv`: the handler keeps the enqueue/detach/persist plumbing,
 * passes in the title-persist callback, and shares the mutable counters via {@link StreamState}.
 * That split is what makes the reducer unit-testable (see streamUpdate.spec.ts), so the branching
 * has direct tests.
 *
 * Returns the event to enqueue to the client: identical to the input except Stream events, whose
 * token is null-padded to a fixed width (a side-channel defense, see below). Returns `null` for an
 * empty-token Stream event — the handler drops it entirely (no enqueue, no audit, no persist),
 * matching the original closure's early `return`.
 */

/** Per-generation mutable counters + flags shared between the reducer and the handler's stream loop. */
export interface StreamState {
	/** A FinalAnswer event has set the message's final text. The handler skips the interrupted-final fallback once true. */
	finalAnswerReceived: boolean;
	/** A Status:Finished event has been emitted, so the handler must not emit a second one. */
	finishedStatusSent: boolean;
	/** First content token seen — gates the one-shot time-to-first-token metric. */
	firstTokenObserved: boolean;
	/** Wall-clock of the FIRST content token, captured unconditionally (not metrics-gated) so the
	 *  request-trace can show a real time-to-first-word even when Prometheus metrics are off. */
	firstTokenAt: Date | undefined;
	/** Timestamp of the last content token, for the inter-token latency metric. */
	lastTokenTimestamp: Date | undefined;
	/**
	 * Timestamp of the last event of ANY kind the reducer processed — CUR-1204. The route's silence
	 * watchdog reads this, not `lastTokenTimestamp`, because a content token is not the only liveness
	 * signal worth watching: endpointAgent.ts's 4s heartbeat (built for exactly "the agent computes
	 * silently for many seconds") and the plan/tool_call/tool_result/writePolicy narration all prove the
	 * underlying connection and agent process are alive, and all arrive as
	 * MessageUpdateType.RouterMetadata / AgentStep / WritePolicy — none of them touch
	 * lastTokenTimestamp, which is scoped to real Stream content only. During agent-service's own
	 * internal model-retry window (proxy.py's stall retry, up to 60s) NOTHING but heartbeats arrives,
	 * so a watchdog on tokens alone would end the turn at 45s before that retry could finish. This field
	 * is the actual "is anything still happening" signal; lastTokenTimestamp stays scoped to the metric
	 * it was built for.
	 */
	lastActivityAt: Date | undefined;
	/**
	 * The model's last raw chunk, stamped by textGeneration through `onModelOutput` before the honesty
	 * and screening buffers (CUR-4188). Unlike lastTokenTimestamp it counts output nobody can see yet:
	 * reasoning held until `</think>`, and text a screen is still holding. Read by the total cap's
	 * still-streaming check; unlike lastActivityAt, a heartbeat never touches it.
	 */
	lastModelOutputAt: Date | undefined;
	/** An AgentConfirm gate is open (CUR-218) with no matching AgentConfirmResult yet — a human is
	 *  mid-decision on an Allow/Deny card. True from AgentConfirm to AgentConfirmResult; read by the
	 *  route's silence watchdog (deadlineLadder.isSilentStall, CUR-1085) so a pause a human hasn't
	 *  answered yet is never mistaken for a stalled generation. */
	awaitingConfirmation: boolean;
	/** A code sandbox is waiting for a slot on a full host. True from the `waiting-sandbox` phase
	 *  marker to the next phase marker. The route holds the turn's deadline for it, as for an open card: (CUR-4584)
	 *  agent-service bounds the wait itself, and the deadline's room under MAX_SAFE still caps it. */
	waitingForSandbox: boolean;
}

export function createStreamState(): StreamState {
	return {
		finalAnswerReceived: false,
		finishedStatusSent: false,
		firstTokenObserved: false,
		firstTokenAt: undefined,
		lastTokenTimestamp: undefined,
		lastActivityAt: undefined,
		lastModelOutputAt: undefined,
		awaitingConfirmation: false,
		waitingForSandbox: false,
	};
}

/** Metric handles + their fixed inputs, or undefined when the metrics server is off. */
export interface MetricsContext {
	model: Metrics["model"];
	labels: { model: string };
	promptedAt: Date;
}

export interface ApplyUpdateContext {
	/** The assistant message being streamed into (messageToWriteTo). Mutated in place. */
	message: Message;
	/** The message content before this turn streamed — the splice point for FinalAnswer. */
	initialMessageContent: string;
	/** Only `isRouter` is read, to decide how RouterMetadata is merged. */
	model: { isRouter?: boolean };
	/** Shared mutable counters/flags (also read by the handler after the loop). */
	state: StreamState;
	/** Present only when the metrics server is enabled. */
	metrics?: MetricsContext;
	/** Persist a freshly-sanitized conversation title (the reducer stays free of the DB handle and `conv`). */
	saveTitle: (sanitizedTitle: string) => Promise<void>;
}

export async function applyMessageUpdate(
	event: MessageUpdate,
	ctx: ApplyUpdateContext
): Promise<MessageUpdate | null> {
	const { message, initialMessageContent, model, state, metrics } = ctx;

	// Reaching this reducer at all (CUR-1204) — any event type, including one dropped further down for
	// carrying no visible text — is proof the generation is still alive. Set before any type dispatch or
	// early return so a RouterMetadata heartbeat, an AgentStep pulse, or a WritePolicy notice counts the
	// same as a content token for silence-detection purposes.
	state.lastActivityAt = new Date();

	if (event.type === MessageUpdateType.Status && event.status === MessageUpdateStatus.Finished) {
		state.finishedStatusSent = true;
	}
	// Any later phase marker ends the sandbox wait; the wait's own end sends `sandbox-ready`. (CUR-4584)
	if (event.type === MessageUpdateType.Status && event.message?.startsWith(PHASE_PREFIX)) {
		state.waitingForSandbox = event.message === phaseMarker(SANDBOX_WAIT_PHASE);
	}

	// Add token to content or skip if empty
	if (event.type === MessageUpdateType.Stream) {
		if (event.token === "") return null;
		message.content += event.token;
		// Unconditional (the metrics path below is gated on METRICS_ENABLED): the request-trace needs a
		// real first-token wall-clock regardless of whether Prometheus is on.
		state.firstTokenAt ??= new Date();

		if (metrics) {
			const now = Date.now();
			metrics.model.tokenCountTotal.inc(metrics.labels);

			if (!state.firstTokenObserved) {
				metrics.model.timeToFirstToken.observe(metrics.labels, now - metrics.promptedAt.getTime());
				state.firstTokenObserved = true;
			}

			const previousTimestamp = state.lastTokenTimestamp
				? state.lastTokenTimestamp.getTime()
				: metrics.promptedAt.getTime();
			metrics.model.timePerOutputToken.observe(metrics.labels, now - previousTimestamp);
		}

		state.lastTokenTimestamp = new Date();
	}

	// Append reasoning stream tokens to message.reasoning (server-side)
	else if (
		event.type === MessageUpdateType.Reasoning &&
		event.subtype === MessageReasoningUpdateType.Stream &&
		"token" in event
	) {
		message.reasoning ??= "";
		message.reasoning += event.token;
	}

	// Set the title
	else if (event.type === MessageUpdateType.Title) {
		// Always strip <think> markers from titles when saving
		const sanitizedTitle = event.title.replace(/<\/?think>/gi, "").trim();
		await ctx.saveTitle(sanitizedTitle);
	}

	// Set the final text and the interrupted flag. Tools/MCP were removed in the B1-lite strip, so the
	// provider's final text simply replaces the streamed-so-far text (the old pre-tool merge is gone).
	else if (event.type === MessageUpdateType.FinalAnswer) {
		message.interrupted = event.interrupted;
		message.content = initialMessageContent + event.text;
		state.finalAnswerReceived = true;

		if (metrics) {
			metrics.model.latency.observe(metrics.labels, Date.now() - metrics.promptedAt.getTime());
		}
	}

	// Open-component (MCP) provenance — an open HF Space tool ran for this turn. Stamp message.mcp so the
	// trace reads "open component" after reload. MCP runs INSIDE textGeneration (unlike search/RAG, which
	// the POST handler stamps before generation), so its provenance arrives here as a streamed update.
	else if (event.type === MessageUpdateType.Mcp) {
		message.mcp = mcpProvenance(event) ?? message.mcp;
	}

	// Write-permission provenance (CUR-471) — the agent's writes were resolved to deny_writes for this
	// caller. Stamp message.writePolicy so the explanation survives reload, mirroring Mcp above. Only a
	// real restriction ever stamps (writePolicyProvenance returns undefined for policy:"allow").
	else if (event.type === MessageUpdateType.WritePolicy) {
		message.writePolicy = writePolicyProvenance(event) ?? message.writePolicy;
	}

	// Fixed-reply provenance (CUR-1579, CUR-1872) — no model wrote this turn's reply; the server
	// composed it. Stamp message.fixedReply so the receipt still says so after reload. The low-resource
	// path stamps it directly in the route; the at-capacity notice arrives here from screenStream.
	else if (event.type === MessageUpdateType.FixedReply) {
		message.fixedReply = { kind: event.kind };
	}

	// Code evaluated a calculate call. Accumulated so every expression stays under the answer
	// after reload. (CUR-2273)
	else if (event.type === MessageUpdateType.Calculation) {
		message.calculations = calculationAppended(message.calculations, event);
	}

	// One call to a configured MCP server. Accumulated so the trace keeps every call after reload. (CUR-3026)
	else if (event.type === MessageUpdateType.McpCall) {
		message.mcpCalls = mcpCallAppended(message.mcpCalls, event);
	}

	// A native turn's tools retrieved sources mid-answer. The scaffolded route stamps these
	// itself before generation; on a native turn this is the only place they are written. (CUR-2420)
	else if (event.type === MessageUpdateType.Rag) {
		message.rag = ragProvenance(event) ?? message.rag;
	} else if (event.type === MessageUpdateType.WebSearch) {
		const stamp = searchProvenance(event);
		message.webSearch = stamp ?? message.webSearch;
		// A native turn's later search grounded it, so an earlier failed one no longer applies.
		if (stamp) message.searchAttempt = undefined;
	}

	// A native turn's web_search ran and did not finish. The scaffolded route stamps its own;
	// this is where a native turn's is written, so the note under the answer survives reload. (CUR-4091)
	else if (event.type === MessageUpdateType.SearchAttempt) {
		message.searchAttempt = {
			grounded: false,
			searched: event.searched,
			...(event.failed ? { failed: event.failed } : {}),
		};
	}

	// A backup lane serving a different model took over from the primary. Stamped so the
	// receipt keeps the attempt after reload. (CUR-2239)
	else if (event.type === MessageUpdateType.Failover) {
		message.failover = {
			from: event.from,
			to: event.to,
			reason: event.reason,
			...(event.cause ? { cause: event.cause } : {}),
		};
	}

	// Files the turn could not read, named before the answer. Stamped so it survives reload. An
	// upload refusal (CUR-2382) is stamped where it is decided, in the route. (CUR-3291)
	else if (event.type === MessageUpdateType.AttachmentNotice && event.kind === "unread") {
		message.unreadFilesNotice = event.message;
	}

	// Older exchanges were left out so the chat fit the model's context. Stamped so the note
	// under the answer survives reload. (CUR-2893)
	else if (event.type === MessageUpdateType.HistoryNotice) {
		message.historyLeftOut = event.leftOut;
	}

	// Agent tool-execution provenance (CUR-601) — the agent observed at least one real ACP tool run this
	// turn. Stamp message.agentTools so the grounding classifier can tell it apart from "recall" after
	// reload, mirroring WritePolicy above. Only a genuinely tool-running turn ever stamps
	// (agentToolsProvenance returns undefined for an empty toolKinds).
	else if (event.type === MessageUpdateType.AgentTools) {
		message.agentTools = agentToolsProvenance(event) ?? message.agentTools;
	}

	// The agent-service task this turn submitted, kept so a later visit can re-attach to it. (CUR-993)
	else if (event.type === MessageUpdateType.AgentRun) {
		message.agentRun = {
			taskId: event.taskId,
			...(event.machineId ? { machineId: event.machineId } : {}),
			...(event.closed ? { closed: true } : {}),
		};
	}

	// Unrun-code provenance (CUR-1341) — this turn's answer is predicted, not measured. Stamp
	// message.unrunCode so the reasoning panel's header still says so after reload, instead of falling
	// back to "Computed" while the caveat one line below it says nothing ran. Mirrors AgentTools above;
	// the server emits this only when its own unrun check fired, so there is no empty case to filter.
	else if (event.type === MessageUpdateType.UnrunCode) {
		message.unrunCode = unrunCodeProvenance(event) ?? message.unrunCode;
	}

	// Agent confirmation gate opened (CUR-218) — accumulates, doesn't replace: see agentConfirmOpened.
	// Also arms the silence-watchdog exemption (CUR-1085): a card with nobody answering yet produces no
	// tokens, and that silence must not read as a stalled generation.
	else if (event.type === MessageUpdateType.AgentConfirm) {
		message.agentConfirmations = agentConfirmOpened(message.agentConfirmations, event);
		state.awaitingConfirmation = true;
	}

	// Agent confirmation gate resolved (CUR-218) — fills in the matching open entry in place, and
	// disarms the CUR-1085 exemption so a genuine post-confirm stall is caught normally again.
	else if (event.type === MessageUpdateType.AgentConfirmResult) {
		message.agentConfirmations = agentConfirmResolved(message.agentConfirmations, event);
		state.awaitingConfirmation = false;
	}

	// Add file. A re-attached agent turn replays its `done`, so an agent file already on the message is
	// not added twice; two agent files with the same bytes keep a reference each, told apart by path.
	// Any other file is appended as before (CUR-4398).
	else if (event.type === MessageUpdateType.File) {
		if (!event.agentPath || !message.files?.some((f) => f.value === event.sha && f.agentPath === event.agentPath)) {
			message.files = [
				...(message.files ?? []),
				{
					type: "hash",
					name: event.name,
					value: event.sha,
					mime: event.mime,
					...(event.agentPath ? { agentPath: event.agentPath } : {}),
				},
			];
		}
	}

	// Store router metadata: route/model (for router models AND any model whose served backend
	// differs from its id) plus provider info.
	else if (event.type === MessageUpdateType.RouterMetadata) {
		// Last-non-empty-wins merge: route/model/provider can arrive in SEPARATE frames (a router
		// sends route/model first, provider later; the agent sends its real executor as a route+model
		// done.model correction, then a provider-only finalize frame arrives with model:""). Merging
		// non-empty fields keeps each frame's contribution and stops a later empty frame clobbering a
		// model already set. A router model always merges; a non-router model merges only when a frame
		// actually carries something — so the agent (selects "potluck-agent", serves e.g. Mistral) gets
		// its executor recorded, while a plain single-model turn (never sends a differing route/model)
		// is unaffected. Without this the non-router path would store provider ONLY and drop route/model,
		// so the agent's executor would be lost and the badge would show the conversation default.
		if (
			model.isRouter ||
			event.route ||
			event.model ||
			event.provider ||
			event.backend ||
			event.verifyMethod !== undefined ||
			Boolean(event.assistedBy?.length) ||
			Boolean(event.answerLanguage)
		) {
			// The served backend is persisted so provenance survives reload and the served-lane
			// assertion has something to read; verifyMethod merges on presence (CUR-756). The live page
			// merges with the same function, so the badge and the record cannot drift (CUR-2135).
			message.routerMetadata = mergeRouterMetadata(message.routerMetadata, event);
		}
	}

	// Append updates for audit/replay (streams too, to preserve ordering). AgentStep is a
	// transient live-stack animation beat (the step history persists in the <think> block and
	// the verified answer), so it streams to the client but is NOT written to the audit log.
	if (
		!(event.type === MessageUpdateType.Status && event.status === MessageUpdateStatus.KeepAlive) &&
		event.type !== MessageUpdateType.AgentStep
	) {
		message.updates?.push(event.type === MessageUpdateType.Stream ? { ...event } : event);
	}

	// Avoid remote keylogging attack executed by watching packet lengths
	// by padding the text with null chars to a fixed length
	// https://cdn.arstechnica.net/wp-content/uploads/2024/03/LLM-Side-Channel.pdf
	let outgoing: MessageUpdate = event;
	if (event.type === MessageUpdateType.Stream) {
		outgoing = { ...event, token: event.token.padEnd(16, "\0") } satisfies MessageStreamUpdate;
	}

	message.updatedAt = new Date();
	return outgoing;
}

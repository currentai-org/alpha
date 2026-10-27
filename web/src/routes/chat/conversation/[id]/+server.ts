import { updateRequestContext } from "$lib/chat/server/requestContext";
import { preconnectRouter } from "$lib/chat/server/upstreamFetch";
import { countryFromHeader } from "$lib/chat/crisisLocale";
import { authCondition } from "$lib/chat/server/auth";
import { collections } from "$lib/chat/server/database";
import { config } from "$lib/chat/server/config";
import { requestBillTo } from "$lib/chat/server/hfBillTo";
import { describeServingLane } from "$lib/chat/server/endpoints/openai/providerPin";
import { models, defaultModel } from "$lib/chat/server/models";
import { resolveConversationModel } from "$lib/chat/server/conversationModel";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import { formerWorkspaceNameOf, hasWorkspaceMark } from "$lib/chat/server/formerWorkspaces";
import {
	getEffectiveModels,
	getEffectiveValidModelIdSchema,
	LOCAL_MODEL_ID_PREFIX,
	prewarmLocalModelForUser,
} from "$lib/chat/server/localModels";
import { error, isHttpError } from "@sveltejs/kit";
import { ObjectId } from "bson";
import { syncBump, tombstoneConversations } from "$lib/chat/server/sync/syncTouch";
import { z } from "zod";
import { chargeScreeningCost, enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { loadAuthorizedConversation } from "$lib/chat/server/chat/loadConversation";
import { parseChatRequest } from "$lib/chat/server/chat/parseRequest";
import { autoRouteForTurn } from "$lib/chat/server/chat/autoRoute";
import { autoRepickEnabled, autoRepickGiveUpFor } from "$lib/chat/server/autoRepickGate";
import { createConversationWriteChain } from "$lib/chat/server/chat/conversationWriteChain";
import { AGENT_MODEL_ID, resolveAgentRoute } from "$lib/chat/server/chat/resolveAgentRoute";
import { agentModeEnabledForUser } from "$lib/chat/server/agentMode";
import {
	GROUNDCHECK_FAULT_EVIDENCE,
	groundcheckEnabled,
	groundcheckEvidence,
	groundcheckFaultCheck,
} from "$lib/chat/server/groundcheck";
import { groundcheckStage } from "$lib/chat/server/textGeneration/groundcheckStage";
import { harnessForTurn } from "$lib/chat/server/harness";
import { evalLayers, markEvalLayerApplied, appliedEvalLayers } from "$lib/chat/server/evalLayers";
import { auditCitations } from "$lib/chat/server/citationAudit";
import { detectNameAdoption } from "$lib/chat/server/nameGuard";
import { stripFenceTags, stripResponseTags } from "$lib/chat/server/textGeneration/grounding";
import {
	harassmentRuleJudge,
	QUESTION_SAVE_DELAY_MS,
	outputScreenWindowFaultMs,
	resolveFakeAgent,
	resolveFaultInjection,
	resolveGuardLive,
	resolveReplayMode,
	SESSION_RATE_LIMIT_FAULT,
	unreachableGuardJudge,
	watchdogDeadlineMs,
} from "$lib/chat/server/textGeneration/faultInjection";
import { fakeAgentFetch } from "$lib/chat/server/endpoints/agent/fakeAgentService";
import { upstreamBusyMessage } from "$lib/chat/server/textGeneration/upstreamBusy";
import {
	resolvePreviewScreenStub,
	stubGuardVerdict,
	stubOutputScreen,
} from "$lib/chat/server/textGeneration/previewScreenStub";
import { upstreamDroppedMessage } from "$lib/chat/server/textGeneration/upstreamDropped";
import {
	upstreamSilentMessage,
	watchdogCountsTowardBusy,
	watchdogTimedOutMessage,
} from "$lib/chat/server/textGeneration/upstreamSilent";
import { noteFailed } from "$lib/chat/server/modelBusy";
import { ordinaryTurnTimeout } from "$lib/chat/server/turnDeadlines";
import { upstreamFailedMessage } from "$lib/chat/server/textGeneration/upstreamFailed";
import { messageTooLongMessage } from "$lib/chat/server/textGeneration/chatTooLong";
import { overContextBeforeScreen } from "$lib/chat/server/endpoints/openai/fitHistory";
import { contextTokensFor, generationTimeoutMsFor } from "$lib/chat/server/harnessProfiles";
import { CANNED_READ_ALOUD_CLIP } from "$lib/chat/server/mcp";
import {
	detectLowResourceLanguage,
	lowResourceFallbackMessage,
	lowResourceNoticeAlreadyShown,
	withLowResourceNoticeSummarized,
} from "$lib/chat/server/textGeneration/languageFallback";
import { preferredLanguage } from "$lib/chat/constants/starterShelf";
import { lowResourceLanguageFallbackEnabled } from "$lib/chat/server/languageFallbackGate";
import { withTruncationNotice } from "$lib/chat/server/endpoints/openai/openAIChatToTextGenerationStream";
import { resolveForceMultimodal } from "$lib/chat/server/multimodalMode";
import { resolveReasoningEffort } from "$lib/chat/server/reasoningEffortMode";
import { appendTurnMessages } from "$lib/chat/server/chat/messageTree";
import { applyMessageUpdate, createStreamState } from "$lib/chat/server/chat/streamUpdate";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	phaseMarker,
	PRESTREAM_EVENTS_HEADER,
	PRESTREAM_STARTING_PHASE,
	PRESTREAM_ACCEPTED_PHASE,
	type MessageUpdate,
	type MessageStatusUpdate,
	type MessageStreamUpdate,
	type ModerationKind,
} from "$lib/chat/types/MessageUpdate";
import {
	checkAdvisory,
	CHILD_SAFETY_DECLINE,
	childSafetyDeclineText,
	CONTENT_POLICY_DECLINE,
	reportHitToCoop,
	screenModelOutput,
} from "$lib/chat/server/moderation";
import { GUARD_CORPUS_CAP, type GuardHit } from "$lib/chat/server/guardScreenTypes";
import { withGuardShadow } from "$lib/chat/server/guardShadow";
import { countGuardHitsSafe } from "$lib/chat/server/db/guardDailyCounts";
import { runInputGate, screenedForRecord } from "$lib/chat/server/inputGate";
import { S1_JUDGE } from "../../../../../config/safetyScreen";
import { inputJudgesFor, inputScreenFlags, resolveTurnPolicy, screenOutputWithGuard, s1JudgeFor } from "$lib/chat/server/guardGate";
import {
	recheckFault as recheckFaultRecheck,
	recheckFaultFlag,
	recheckOutputBlock,
	type OutputRecheck,
} from "$lib/chat/server/outputRecheck";
import { outputAskerText, prepareScreenedTurnMedia } from "$lib/chat/server/chat/prepareTurnMedia";
import { clientAuthoredInstructions, withClientInstructions } from "$lib/chat/server/clientInstructions";
import { personalInstructionsFrom } from "$lib/chat/personalInstructions";
import { documentAttachmentsEnabled } from "$lib/chat/server/documentAttachmentsGate";
import { CLIPBOARD_MIME, DOCUMENT_MIME_ALLOWLIST } from "$lib/chat/constants/mime";
import { isSupportRule, resolveActionLabel, resolveActionMessage } from "$lib/chat/server/ruleLabel";
import { declineLanguageFromTag, readMessageLanguage } from "$lib/chat/server/declineCopy";
import { stampSupportFromSignal, supportSignal, supportSignalEnabled } from "$lib/chat/server/supportSignal";
import { screenOutputStream, type OutputScreenLedger } from "$lib/chat/server/textGeneration/screenStream";
import { honestyScreenStream } from "$lib/chat/server/textGeneration/honestyStream";
import { cutRepetitionLoop } from "$lib/chat/server/textGeneration/loopCut";
import { countNumbers, type RungStep } from "$lib/chat/types/Rungs";
import {
	followUpNote,
	ledgerAnswerNote,
	ledgerPrefixStream,
	mathRoutingEnabled,
	plannerSeesTurn,
	plansTurnFor,
	plannedMathForcesCalculate,
	namedServedModel,
	PLAN_TIMEOUT_MS,
	planTurn,
	settleReplacedAnswer,
	stripForgedStamp,
	type Ledger,
} from "$lib/chat/server/textGeneration/mathRouting";
import { ensureFlagsPolled, flagEnabledOr } from "$lib/chat/server/flags";
import { FAILOVER_ON_SILENT_LANE_FLAG, NoFirstChunkError } from "$lib/chat/server/endpoints/failover";
import {
	groundedBailRegenEnabled,
	runGroundedBailRegen,
	runRecitalRegen,
} from "$lib/chat/server/textGeneration/groundedBailRegen";
import { answerLengths } from "$lib/chat/server/textGeneration/answerLength";
import { classifyTurnOutcome } from "$lib/chat/utils/outcomeLadder";
import { parseVisitorSources } from "$lib/chat/utils/visitorSources";
import {
	searchProvenance,
	searchAttemptNotice,
	moderationMarker,
	ragProvenance,
	assistedByEntry,
} from "$lib/chat/messageProvenance";
import { maybeRagGrounding, ragWillSearch } from "$lib/chat/server/rag";
import { localStoreReady, queryLocalStore } from "$lib/chat/server/rag/localStore";
import {
	runWebSearch,
	runWebRetrieval,
	type WebSearchFailure,
	decideWebSearch,
	deciderImages,
} from "$lib/chat/server/search/runSearch";
import { assistedByEnabled } from "$lib/chat/server/assistedByGate";
import type { AssistedBy } from "$lib/chat/types/Message";
import {
	numberWebSources,
	fetchLinkedPage,
	type WebSearchOutcome,
	type WebRetrieval,
} from "$lib/chat/server/search/openSearch";
import { extractLinkedUrl, type LinkedPageState } from "$lib/chat/server/search/linkedUrl";
import { webSearchPlan } from "$lib/chat/search/webSearchPlan";
import type { AttachmentKind } from "$lib/chat/server/search/classifierPrompt";
import { asksForTheLatest, isRecencyQueryDenoised, isUnservableLiveQuery } from "$lib/chat/search/recency";
import { classifyQueryIntent } from "$lib/chat/search/queryIntent";
import { logDeclineSafe } from "$lib/chat/server/db/safetyEvents";
import { usageLimits } from "$lib/chat/server/usageLimits";
import { textGeneration } from "$lib/chat/server/textGeneration";
import type { TextGenerationContext } from "$lib/chat/server/textGeneration/types";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";
import { logger } from "$lib/chat/server/logger.js";
import { providerStampEnabled, readIdentityWithin, startSelfIdentityVerdict } from "$lib/chat/server/selfIdentity";
import { nativeGateSaysSearch } from "$lib/chat/server/search/nativeSearchGate";
import { searchIntentEnabled } from "$lib/chat/server/search/searchIntent";
import { AbortRegistry } from "$lib/chat/server/abortRegistry";
import { clampStoppedContent } from "$lib/chat/server/stopTruncation";
import { summarizeInterruptedAgentWork } from "$lib/chat/utils/trace/interruptedAgentSummary";
import { stripThink } from "$lib/chat/server/stripThink";
import { MetricsServer } from "$lib/chat/server/metrics";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import {
	claimGeneration,
	readGeneration,
	finishGeneration,
	answersInFlight,
} from "$lib/chat/server/generations";
import { settlePendingAnswers } from "$lib/chat/server/chat/settlePendingAnswers";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";
import { recordTurnOutcome } from "$lib/chat/server/db/turnOutcomes";
import { runInBackground, nodeRequestContext } from "$lib/chat/server/vercelBackground";
import {
	GenerationDeadlineExceeded,
	GenerationWatchdogAbort,
	ScreenAwareDeadline,
	boundedSettle,
	raceGenerationDeadline,
	raceScreenAwareDeadline,
} from "$lib/chat/server/chat/generationDeadline";
import {
	DEFAULT_AGENT_GENERATION_TIMEOUT_MS,
	DEFAULT_LOCAL_GENERATION_TIMEOUT_MS,
	DEFAULT_SILENCE_TIMEOUT_MS,
	EMERGENCY_CLEANUP_BUDGET_MS,
	HARD_UNWIND_GRACE_MS,
	isSilentStall,
	isStillStreaming,
	MAX_SAFE_GENERATION_TIMEOUT_MS,
	PRESTREAM_CHAIN_DEADLINE_MS,
	resolveGenerationTimeoutMs,
	screenAllowanceMs,
	screenDeadlineCapMs,
	SILENCE_CHECK_INTERVAL_MS,
	withModelFloor,
} from "$lib/chat/utils/deadlineLadder";
import {
	tryAcquireGenerationSlot,
	releaseGenerationSlot,
	generationInFlight,
} from "$lib/chat/server/chat/generationGate";

// How long a stop marker is protected from the pre-flight cleanup of a new
// generation. A marker younger than this may still be awaiting observation by
// a running generation's 300ms watcher (possibly on another pod); deleting it
// would lose the stop. Aborted generations consume their marker on shutdown,
// so markers normally live far shorter than this.
const STOP_MARKER_GRACE_MS = 5_000;

// Thrown by the pre-stream chain when claimGeneration loses to an existing claim — a duplicate POST
// of the SAME logical turn (a network auto-retry). Carries the W2 idempotency info both failure
// surfaces need: the legacy path returns it as today's HTTP 409 JSON body; the prestream-events path
// emits it as a Status/Error event with `conflict` so the opted-in client attaches instead of erroring.
class GenerationConflictSignal extends Error {
	constructor(readonly info: { status: string; conversationId: string; messageId: string }) {
		super(`generation already ${info.status}`);
		this.name = "GenerationConflictSignal";
	}
}

// How often the prestream-events path re-emits the `phase:starting` keepalive while the pre-stream
// chain runs. The client's first-token watchdog is silence-based (8s) and the chain can legitimately
// take longer (resolveAgentRoute alone may wait up to 20s on the agent /route classifier), so the
// chain must keep proving liveness the same way the retrieval phase already does (retrievalHeartbeat).
const PRESTREAM_HEARTBEAT_MS = 2_500;

// The longest the FinalAnswer persist may hold the answer back from the client (CUR-2078). A Neon
// write normally takes tens of milliseconds; past this the answer goes out and the write finishes
// behind it.
const FINAL_ANSWER_PERSIST_WAIT_MS = 1_500;

// Hard backstop for the pre-stream chain itself (conversation load, rate limits, model resolve, agent
// route, turn append, W2 claim, persist). The generation hard-deadline (raceGenerationDeadline around
// generationWork) only wraps generation — a chain step that HANGS (not throws) never reaches it and rides
// the invocation to the platform kill. This bounds the chain: generous enough for a cold start
// (resolveAgentRoute alone can wait ~20s, plus a cold DB connect), well under the SSE lifetime and the
// platform cap. A chain still running past this is provably stuck, not slow.
//
// This and the constants below are rungs of the deadline ladder, not free-standing numbers — they
// are ordered against each other and against the platform kill. See $lib/chat/utils/deadlineLadder.

// Map a pre-stream chain failure to the Status/Error event the opted-in client translates back into
// the SAME typed errors the HTTP statuses used to produce (GenerationConflictError / 429 with its
// verbatim rate-limit message / GenerationRequestError). Anything that is neither the conflict signal
// nor a SvelteKit HttpError (raw Zod/JSON.parse throws in parseChatRequest, uploadFile or tree-helper
// errors, DB failures) maps to a generic 500 — exactly what SvelteKit's unhandled-error path returned.
function isLocalModelId(modelId: string | undefined): boolean {
	return modelId?.startsWith(LOCAL_MODEL_ID_PREFIX) ?? false;
}

/** The turn's generation timeout from its own knob: agent, local, or ordinary. The input screen reads
 *  it before the stream to size its cap, and the watchdog reads it to arm. An ordinary turn on a model
 *  with its own floor (harnessProfiles.ts `generationTimeoutMs`, CUR-4403) gets at least that. */
function turnGenerationTimeout(modelId: string | undefined, isAgentTurn: boolean) {
	return isAgentTurn
		? resolveGenerationTimeoutMs(Reflect.get(config, "AGENT_GENERATION_TIMEOUT_MS"), DEFAULT_AGENT_GENERATION_TIMEOUT_MS)
		: isLocalModelId(modelId)
			? resolveGenerationTimeoutMs(Reflect.get(config, "LOCAL_GENERATION_TIMEOUT_MS"), DEFAULT_LOCAL_GENERATION_TIMEOUT_MS)
			: ordinaryTurnTimeout(modelId);
}

function prestreamFailureUpdate(e: unknown): MessageStatusUpdate {
	if (e instanceof GenerationDeadlineExceeded) {
		// The chain itself blew the hard deadline (PRESTREAM_CHAIN_DEADLINE_MS) — a stuck step, not a
		// throw. Surface it as the SAME retryable 504 the generation hard-deadline emits, so the client's
		// bounded retry re-issues with a fresh generationId rather than treating it as a permanent 500.
		return {
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.Error,
			statusCode: 504,
			message: "The request took too long to respond. Please try again.",
		};
	}
	if (e instanceof GenerationConflictSignal) {
		return {
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.Error,
			statusCode: 409,
			message: e.message,
			conflict: e.info,
		};
	}
	if (isHttpError(e)) {
		return {
			type: MessageUpdateType.Status,
			status: MessageUpdateStatus.Error,
			statusCode: e.status,
			message: e.body.message,
			...(e.body.retryAfterSeconds ? { retryAfterSeconds: e.body.retryAfterSeconds } : {}),
		};
	}
	return {
		type: MessageUpdateType.Status,
		status: MessageUpdateStatus.Error,
		statusCode: 500,
		message: "Internal Error",
	};
}

// The ONE output-review finalizer. Memoized (once) so normal completion,
// cancel(), and the hard deadline converge on a single execution; `.settled` resolves when it has run,
// so the route can register it with waitUntil for lifetime. It flips ledger.stopped (the terminal
// boundary the generator reads), drains every screen ever dispatched (bounded), merges hits by key, and
// emits AT MOST ONE /report per assistant message — server-only, never the persisted marker. NEVER
// rejects (reportHitToCoop never rejects; the drain is caught).
type OutputFinalizer = (() => Promise<void>) & { settled: Promise<void> };
// The guard's own per-operation deadline (20s) plus grace: every dispatched screen is internally bounded,
// so the drain settles well within this; the race is a safety net so a hung screen cannot wedge the turn.
const OUTPUT_FINALIZE_BUDGET_MS = 25_000;

function makeOutputFinalizer(
	ledger: OutputScreenLedger,
	messageId: string,
	subjectId: string | undefined
): OutputFinalizer {
	let ran: Promise<void> | undefined;
	let resolveSettled!: () => void;
	const settled = new Promise<void>((r) => (resolveSettled = r));
	const fn = (() => {
		if (!ran) {
			ran = (async () => {
				ledger.stopped = true; // terminal boundary: the generator screens/releases nothing more
				// Bound EACH screen independently (not the whole set): a single hung screen loses only its
				// own result, never the hits that already settled. Each dispatched promise is
				// already internally deadline-bounded, so this race is a safety net.
				const results = await Promise.all(
					ledger.dispatched.map((d) =>
						Promise.race([
							d.promise.then((v) => ({ ok: true as const, value: v })).catch(() => ({ ok: false as const })),
							new Promise<{ ok: false }>((res) => setTimeout(() => res({ ok: false as const }), OUTPUT_FINALIZE_BUDGET_MS)),
						])
					)
				);
				const hits = new Map<string, GuardHit>();
				let text = ledger.released; // what the user saw
				results.forEach((r, i) => {
					if (!r.ok) return;
					const fired = r.value.hits ?? [];
					if (fired.length === 0) return;
					for (const h of fired) hits.set(h.key, h);
					// A fired batch that was NOT released (blocked/dropped) is appended ONCE so the reviewer
					// sees it — keyed on the entry's `released` flag, not a substring match, and
					// outside the per-hit loop so a multi-hit entry is not appended repeatedly.
					const entry = ledger.dispatched[i];
					if (entry && !entry.released) text += entry.text;
				});
				if (hits.size > 0) {
					await reportHitToCoop({
						surface: "chat-output",
						messageId,
						text: text.slice(0, GUARD_CORPUS_CAP),
						hits: [...hits.values()],
						subjectId,
					});
				}
			})()
				.catch(() => {})
				.finally(() => resolveSettled());
		}
		return ran;
	}) as OutputFinalizer;
	fn.settled = settled;
	return fn;
}

export async function POST({ request, locals, params, getClientAddress }) {
	const id = z.string().parse(params.id);
	const convId = new ObjectId(id);
	const promptedAt = new Date();

	const userId = locals.user?._id ?? locals.sessionId;

	// check user
	if (!userId) {
		error(401, "Unauthorized");
	}

	// Resolved once, up front — cheap (env check + one HMAC compare) and every real user
	// turn resolves to null in one branch, so there's no reason to defer it into the stream body where
	// ctx gets built. See faultInjection.ts for the full gate. (CUR-1614)
	const faultInjection = await resolveFaultInjection(request);
	// A scenario run replays every model call this turn makes, from the answer to its side
	// calls, which read the mode from the request's context. (SOL-148)
	const replayMode = await resolveReplayMode(request);
	if (replayMode) updateRequestContext({ replayMode });
	if (await resolveGuardLive(request)) updateRequestContext({ guardLive: true });
	// A scenario run's agent turn, and Auto's route check, go to the in-process stand-in for
	// agent-service rather than a shared agent machine. See fakeAgentService.ts.
	const fakeAgent = await resolveFakeAgent(request);
	if (fakeAgent) updateRequestContext({ fakeAgent });
	// A PR preview's scenario send may ask for a screen that allows everything, so the suite
	// stops queueing the one Shieldstral GPU production screens through. See previewScreenStub.ts. (CUR-3110)
	const screenStub = await resolvePreviewScreenStub(request);
	// `chat_500` answers the send as an unhandled throw in this handler does, before any
	// stream exists, so a spec sees what a visitor gets when the turn's request itself fails. (CUR-1614)
	if (faultInjection === "chat_500") error(500, "Internal Error");
	// The router is an ocean away from fra1; open its connection while retrieval runs (upstreamFetch.ts).
	if (!replayMode) preconnectRouter();

	// A new generation invalidates any stale stop marker for this conversation.
	// The abortedGenerations collection is the cross-pod abort channel:
	// stop-generating upserts a marker, and the watcher in the stream below
	// polls it. Clearing stale markers here — before the client could possibly
	// issue a stop for THIS generation (its fetch has not returned yet) — means
	// any marker observed later was meant for us, with no wall-clock comparison
	// between pods needed. Markers younger than the grace window are preserved:
	// they belong to a stop for a still-winding-down generation in this same
	// conversation (e.g. issued from another tab), whose watcher must get the
	// chance to observe them; aborted generations consume their marker on
	// shutdown, so a fresh marker is never a stale one.
	// Fire-and-forget, fired as early as possible (only needs convId, not conv/userId): the client's
	// fetch hasn't returned yet (no Response exists until well after this point), so it cannot
	// possibly issue a stop for this generation yet either way — awaiting this only adds a blocking
	// DB round trip (the first query of a cold container, worst-case) to the pre-stream critical path
	// for no correctness benefit.
	void collections.abortedGenerations
		.deleteOne({
			conversationId: convId,
			updatedAt: { $lt: new Date(Date.now() - STOP_MARKER_GRACE_MS) },
		})
		.catch((e) => logger.warn(e, "[stop-marker] stale cleanup failed — continuing"));

	// The pre-stream chain: everything that must happen before generation can start (conversation
	// load ∥ rate limits → model → body parse → agent route → turn append → W2 claim → persist).
	// Extracted so it can run on EITHER side of the Response:
	//  - legacy path (no `x-prestream-events` header): awaited BEFORE the Response exists, failures
	//    surface as HTTP statuses — byte-for-byte today's behavior for old clients.
	//  - prestream-events path: awaited INSIDE the stream, so the client gets headers + a first byte
	//    immediately (its connect-timeout can no longer fire mid-chain and re-POST a duplicate turn);
	//    failures surface as Status/Error events (see prestreamFailureUpdate).
	const runPrestream = async () => {
	// Load + authorize the conversation (throws 404/500; see $lib/chat/server/chat/loadConversation)
	// CONCURRENTLY with the per-turn rate limits (per-session, opt-in per-IP, service-wide daily cap;
	// fails open on a DB blip, only an actual over-limit count throws 429 — see
	// $lib/chat/server/chat/rateLimit). Rate limiting only needs userId/clientAddress, not conv, so
	// there's no real dependency forcing it to wait on the conversation load — running them serially
	// was paying both cold-Postgres round trips back to back for no reason. allSettled (not
	// Promise.all) so a slower-settling promise never dangles as an unhandled rejection if the other
	// one throws first; conv's rejection is checked first to preserve the prior precedence (conv-load
	// used to run first, so its 404/500 "won" over a concurrent 429 when both would fail).
	const convLoadStart = Date.now();
	const [convResult, rateLimitResult] = await Promise.allSettled([
		loadAuthorizedConversation({ convId, locals }),
		enforceRequestRateLimits({
			userId,
			clientAddress: getClientAddress(),
			...(faultInjection === "session_rate_limit_low" ? { perSession: SESSION_RATE_LIMIT_FAULT } : {}),
		}),
	]);
	if (convResult.status === "rejected") throw convResult.reason;
	if (rateLimitResult.status === "rejected") throw rateLimitResult.reason;
	// A turn started while the previous one is still saving (Retry right after Stop) would
	// otherwise save its copy over that turn's answer; see settlePendingAnswers. (CUR-2667)
	const settleStart = Date.now();
	const settled = await settlePendingAnswers({
		messages: convResult.value.messages,
		inFlight: (ids) => answersInFlight(convId.toString(), ids),
		reload: () => loadAuthorizedConversation({ convId, locals }),
	});
	if (settled) {
		logger.info(
			{ conversationId: convId.toString(), waitedMs: Date.now() - settleStart },
			"[chat] Waited for an earlier turn's save before building on it"
		);
	}
	const conv = settled ?? convResult.value;
	// What this turn loaded, so its saves merge into the conversation as stored rather than
	// writing this copy over turns another tab saved meanwhile. (CUR-2806)
	const loadedConv = snapshotConversation(conv);
	const convLoadMs = Date.now() - convLoadStart;

	if (usageLimits?.messages && conv.messages.length > usageLimits.messages) {
		error(
			429,
			`This conversation has more than ${usageLimits.messages} messages. Start a new one to continue`
		);
	}

	// A chat from a workspace this person left, or that was deleted, is read-only. The page
	// offers no composer for it; this refuses a turn sent anyway. Only a chat with a workspace mark
	// pays for the read. (CUR-3040)
	// The same read decides whose documents retrieval may cite. A chat reads its own
	// workspace's documents only while the asker is still a member of it; a failed read, the
	// workspaces flag off, or no workspace mark leaves the site-wide corpus alone. (CUR-4152)
	let ragWorkspace: string | null = null;
	if (hasWorkspaceMark(conv)) {
		const scope = await workspaceScopeFor(locals, request.headers);
		const formerName = scope ? formerWorkspaceNameOf(conv, scope) : null;
		if (formerName) {
			error(403, `This chat was in ${formerName}, which you're no longer part of, so it's read-only.`);
		}
		if (conv.organizationId && scope?.memberOrgIds.includes(conv.organizationId)) {
			ragWorkspace = conv.organizationId;
		}
	}

	// Fetch the model (the conversation's selected model; the Agent control may override it below).
	// A conversation created before an allowlist change names an id the registry no longer has; this
	// continues it on the default rather than 410ing, and says so. See conversationModel.ts for why the
	// widening is deliberate and why it must not be silent.
	// Effective = the shared catalog plus THIS user's own local (LAN/self-hosted) endpoint, if any
	// (localModels.ts) — never the raw `models` export alone, or a conversation pinned to a local model
	// would wrongly fall back to the default every turn.
	const effectiveModels = await getEffectiveModels(locals);
	const { model: resolvedModel, retiredId } = resolveConversationModel(
		effectiveModels,
		defaultModel,
		conv.model
	);
	let model = resolvedModel;
	if (retiredId) {
		logger.info(
			{ conversationId: convId.toString(), retiredId, servingModelId: model.id },
			"[chat] Conversation names a model the registry no longer has — continuing on the default"
		);
	}

	// Server-authoritative backstop (CUR-770): the agent's id is excluded from every schema that
	// validates a client-supplied model id (models.ts), so `conv.model` should never legitimately equal
	// it — but this re-checks at the point of actually serving a turn rather than trusting that every
	// write path enforced it, so a stale/legacy row or a future write path that misses the exclusion
	// can't put a non-cleared user's turn on the agent. Mirrors the retiredId pattern above: widen to the
	// default and say so, rather than 400ing mid-turn.
	if (model.id === AGENT_MODEL_ID && !(await agentModeEnabledForUser(locals))) {
		logger.warn(
			{ conversationId: convId.toString(), servingModelId: defaultModel.id },
			"[chat] Conversation names the agent model but this caller isn't cleared for it — continuing on the default"
		);
		model = defaultModel;
	}

	// Parse + validate the multipart body into this turn's typed inputs (prompt, tree position,
	// idempotency id, search grounding, uploaded files), attaching per-turn MCP/timezone context to
	// locals along the way. See $lib/chat/server/chat/parseRequest (throws 400/413/415).
	const parseStart = Date.now();
	const {
		newPrompt,
		messageId,
		isRetry,
		agentAttach,
		generationId,
		newMessageIds,
		webSearchMode,
		speakAll,
		speakMode,
		agentMode,
		autoRoute,
		uploadedFiles,
		attachmentNotice,
		leftOutFiles,
	} = await parseChatRequest({ request, conv, locals, clientAddress: getClientAddress() });
	const parseMs = Date.now() - parseStart;

	// Agent control (composer off/auto/on): may override the selected model with the Potluck agent for
	// this turn. "auto" asks the agent service's /route classifier whether the turn benefits from agentic
	// work. Fail-open — any miss leaves `model` as the selected model (resolveAgentRoute never throws).
	// Per-account access gate (CUR-1440): only accounts selected in the `agent-mode-access` flag's
	// release conditions may route to the agent. Compute it ONLY for a live agent turn; an "off" turn
	// skips it entirely.
	//
	// It makes a network call: `flagEnabledForUser` asks PostHog per person. What keeps that off real
	// traffic is the ordering inside the gate rather than this call site: the deployment-wide
	// `agent-mode` read runs first, so an env where that flag is off returns false before any
	// per-person request is made.
	const agentAllowed =
		agentMode && agentMode !== "off" ? await agentModeEnabledForUser(locals) : false;
	const agentRoute = await resolveAgentRoute({
		selected: model,
		models,
		agentMode,
		prompt: newPrompt,
		agentAllowed,
		carriesDocument:
			documentAttachmentsEnabled() &&
			uploadedFiles.some((f) => (DOCUMENT_MIME_ALLOWLIST as readonly string[]).includes(f.mime)),
		// This turn's upload or an earlier one: every turn re-sends the conversation's attachments
		// (prepareTurnMedia), so "what else is in it?" about a photo is an image turn too.
		hasImage: [...uploadedFiles, ...conv.messages.flatMap((m) => m.files ?? [])].some((f) =>
			f.mime?.startsWith("image/")
		),
		// Search Always is a promise the agent can't keep: it has no web access (see resolveAgentRoute).
		webSearchAlways: webSearchMode === "always",
		// `agent_route_down` (preview only) fails the /route call as an unreachable service does. (CUR-2830)
		// `agent_route_screened` answers it as the agent service's input screen does on a refusal. (CUR-4056)
		...(faultInjection === "agent_route_down"
			? { fetchImpl: () => Promise.reject(new TypeError("fetch failed")) }
			: faultInjection === "agent_route_screened"
				? {
						fetchImpl: async () =>
							new Response(JSON.stringify({ detail: "blocked by moderation (input): fault injection" }), {
								status: 403,
								headers: { "content-type": "application/json" },
							}),
					}
				: fakeAgent
				? { fetchImpl: (url, init) => fakeAgentFetch(url, init) }
				: {}),
	});
	// resolveAgentRoute logs its own decision for every on/auto turn, fallbacks included (CUR-905).
	if (agentRoute.route === "agent") model = agentRoute.model;
	// A re-attach continues an agent task this message already started, so it runs on the agent
	// whatever the composer says, and only for a caller still cleared for agent mode. Which message, and
	// whether it holds a task, appendTurnMessages checks below. (CUR-993)
	if (agentAttach) {
		const agent = models.find((m) => m.id === AGENT_MODEL_ID);
		if (!agent || !(await agentModeEnabledForUser(locals))) {
			error(403, "Agent mode is not available for this account");
		}
		model = agent;
	}
	// Computed here (once `model` is final), inside runPrestream — so the RAG/web-search prelaunch a few
	// lines down (still in this function) can gate on it, and returned below so start() can too (it's a
	// SEPARATE closure over this function's result, not a nested one — see the `= chain` destructuring).
	// endpointAgent's returned function destructures only {messages, abortSignal, locals,
	// conversationId} off its call (endpointAgent.ts) — `preprompt` (where injectSearchGroundingPrompt/
	// injectRagGrounding put the retrieved evidence, see textGeneration/index.ts) is silently dropped. So
	// retrieval on an agent turn would run a real web round-trip, RAG lookup, and margin-gate model call
	// for evidence the agent never sees — while `messageToWriteTo.webSearch`/`.rag` still got stamped, so the
	// client's provenance trace would read "searched the web · N sources" on a turn that never used any of them (CUR-574).
	const isAgentTurn = model.id === AGENT_MODEL_ID;
	// The harness this turn runs under, decided once `model` is final. A native turn's model
	// retrieves through its own tool calls, so the pre-turn retrieval below skips it the way it skips
	// the agent. (CUR-2420)
	const plannedHarness = harnessForTurn(model);
	// The layer test's stream-guards switch, so the honesty stream can be A/B'd per model. (CUR-2697)
	const evalStreamGuards = evalLayers()?.streamGuards;
	if (evalStreamGuards !== undefined) markEvalLayerApplied("streamGuards", evalStreamGuards);
	const harness =
		evalStreamGuards === undefined ? plannedHarness : { ...plannedHarness, streamGuards: evalStreamGuards };
	const retrievesPreTurn = !isAgentTurn && harness.retrieval === "pipeline";
	// The layer test's retrieval switch turns off document retrieval only; web search keeps
	// its own decision. Undefined on every real visitor's turn (see evalLayers.ts). (CUR-2139)
	const evalRetrieval = evalLayers()?.retrieval;
	if (evalRetrieval !== undefined) markEvalLayerApplied("retrieval", evalRetrieval);
	const ragPreTurn = retrievesPreTurn && evalRetrieval !== false;

	// Append this turn's message(s) to the conversation tree (normal / retry / edit) and get the
	// assistant message to stream into plus the prompt subtree. See $lib/chat/server/chat/messageTree.
	const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
		isRetry,
		attach: agentAttach,
		messageId,
		newPrompt,
		uploadedFiles,
		newMessageIds,
	});

	const messageToWriteTo = conv.messages.find((message) => message.id === messageToWriteToId);
	if (!messageToWriteTo) {
		error(500, "Failed to create message");
	}
	// The model this answer was asked of, so a later model switch can't relabel it as a backup. (CUR-3234)
	messageToWriteTo.requestedModel = model.id;
	// Auto's choice, made in the browser, kept when it names the model this turn runs on. (CUR-3944)
	const autoRouted = autoRouteForTurn(autoRoute, model.id, isRetry);
	if (autoRouted) messageToWriteTo.autoRoute = autoRouted;
	// This turn's files were refused because they could not be scanned. Stored on the answer
	// so a reload still says why, and streamed first thing in generationWork below. (CUR-2382)
	if (attachmentNotice) {
		messageToWriteTo.attachmentNotice = { message: attachmentNotice };
	}
	// The sent message keeps the files left out of it, by name, so they don't vanish from it
	// when the answer lands. The answer's note above says why. (CUR-3405)
	if (leftOutFiles.length) {
		const questionId = messageToWriteTo.ancestors?.at(-1);
		const question = conv.messages.find((m) => m.id === questionId && m.from === "user");
		if (question) question.leftOutFiles = leftOutFiles;
	}
	// Auto's route check failed, so the selected model answers a turn nobody judged ordinary.
	// Stored on the answer and streamed first thing in generationWork, as the attachment note is. (CUR-2830)
	if (agentRoute.failed && !agentAttach) {
		messageToWriteTo.agentRouteFailed = true;
	}
	if (messagesForPrompt.length === 0) {
		error(500, "Failed to create prompt");
	}

	// (Open-web provenance is not stamped here from a client-attached searchContext — web search
	// runs SERVER-side, AFTER community/RAG, so the answer can prefer community sources and number
	// the web after them. The stamp + stream happen in the generation flow below; see runWebSearch.)

	// W2 idempotency: claim this turn by its client-minted generationId BEFORE persisting the new
	// messages, so a duplicate POST — a network auto-retry of the SAME logical turn (W3) — cannot create
	// a second turn. claimGeneration is atomic: a fresh (or previously-errored) id is claimed and we
	// proceed; a complete/in-flight id loses the claim → return 409 with the existing turn's status so the
	// client attaches to the running stream (or refreshes a finished turn) instead of double-submitting.
	// Only guards when the client sent a generationId (always, for v4-minted runs); legacy callers without
	// one keep prior behavior. A user-initiated regenerate mints a NEW id, so it isn't deduped against this.
	const claimStart = Date.now();
	if (generationId) {
		const claimed = await claimGeneration(generationId, convId.toString(), messageToWriteTo.id);
		if (!claimed) {
			const existing = await readGeneration(generationId);
			throw new GenerationConflictSignal({
				status: existing?.status ?? "in_flight",
				conversationId: convId.toString(),
				messageId: existing?.messageId ?? messageToWriteTo.id,
			});
		}
	}
	const claimMs = Date.now() - claimStart;

	// ── Post-claim: prelaunch settings + the gate/RAG/web legs + the per-request write chain (§A) ────
	// EVERYTHING below launches ONLY AFTER the claim wins (invariant 2): getCoopVerdict is NOT read-only
	// (it submits the turn for audit/strike accounting), so a duplicate POST that lost the claim already
	// threw the conflict above and fires ZERO of these — no settings read, no Coop/guard submit, no
	// embeds, no engines, no user-msg persist. The stream's start() joins them in order.

	// Full per-turn span sink — the pre-stream spans (here), RAG (incl. SyftHub stage decomposition),
	// generation, and output screening each write their phase here; the first-token finalizer folds it
	// into message.timings so the whole TTFT decomposition is durable + queryable, not log-only. Created
	// here (chain scope) because the RAG leg is launched here and writes its sub-spans into it.
	const turnSpans: TurnSpans = { convLoadMs, parseMs, claimMs };

	// The single per-request conversation-write chain (invariant 3): the user-msg persist, saveTitle, and
	// every persistConversation flow through it so two whole-document updateOne can never race.
	const writeChain = createConversationWriteChain();

	// Persist the new messages as the chain's FIRST link — do NOT await it here (it overlaps retrieval);
	// its result is awaited inside stream start() as an early join, before generation (invariant 5). The
	// returned promise KEEPS its rejection for that join — a failed persist errors the turn before any
	// model call (the stream catch sets hasError, so the tail's finishGeneration('error') releases the
	// claim exactly like the old awaited-persist release did) — and the chain's tail-advance also
	// registers a handler on it, so if an earlier join throws first and this join is never reached, a
	// concurrently-failing persist is not an unhandled rejection (invariant 7).
	// ⚠️ This write's `updatedAt` is what GENERATION_STALE_MS is measured against, and the deadline
	// ladder's clamp (MAX_SAFE_GENERATION_TIMEOUT_MS) is sound only because this is effectively the
	// LAST act of the prestream chain: everything expensive precedes it, and every await between here
	// and the generation watchdog's arm is inside an unawaited closure, so the residual is ~0. Nothing
	// enforces that structurally. Do not introduce an awaited step between this write and the watchdog
	// arm without revisiting $lib/chat/utils/deadlineLadder.
	// Fault injection: hold the question back the way a cold instance does, so a reload can land in the gap
	// before it is saved (CUR-1893). Before the write, so the ladder note above still holds.
	if (faultInjection === "question_save_delayed") {
		await new Promise((resolve) => setTimeout(resolve, QUESTION_SAVE_DELAY_MS));
	}
	const persistUserMsgStart = Date.now();
	const userMsgPersist = writeChain.enqueue(async () => {
		const r = await saveConversationMessages({ _id: convId }, loadedConv, {
			messages: conv.messages,
			title: conv.title,
			updatedAt: new Date(),
		});
		turnSpans.persistUserMsgMs = Date.now() - persistUserMsgStart;
		return r;
	});

	// The user's turn text, re-derived once for the gate/RAG legs; coopUserId is the review subject
	// (userId else sessionId — the existing guest convention).
	const userTextToScreen =
		[...messagesForPrompt].reverse().find((m) => m.from === "user")?.content ?? "";
	const coopUserId = userId ? String(userId) : undefined;
	// The id of THIS turn's user message — the item a chat-input detection hit is reported against
	// Known pre-stream; a reviewer follows it into the admin tooling for
	// any withheld image/file bytes (which never go to Coop).
	const userMessageId = [...messagesForPrompt].reverse().find((m) => m.from === "user")?.id;
	const userTextToRag = userTextToScreen;
	// The language a refusal reads in, from what the person wrote (CUR-4051). Detection runs beside the
	// screen and is awaited only on a decline; it never rejects and falls back to English.
	// The raw tag also reaches the sources pointer, which covers more languages than a decline (CUR-4339).
	const messageLanguagePromise = readMessageLanguage(userTextToScreen);
	const declineLanguagePromise = messageLanguagePromise.then(declineLanguageFromTag);
	// The multilingual support signal, started beside the screen. Never rejects; null when off.
	// A turn the screen declines drops the result: its card comes from the decline itself. (CUR-4093)
	const supportSignalPromise = supportSignalEnabled() ? supportSignal(userTextToScreen) : Promise.resolve(null);
	// Sources the visitor numbered in their own message keep [1..k]; ours are numbered after them. (CUR-3844)
	const visitorSourceCount = parseVisitorSources(userTextToRag).length;
	// Computed here, before the moderation gate/RAG/media promises launch below, so a match
	// can short-circuit the whole turn before any of that work starts — cheapest possible placement, and
	// the one that most cleanly guarantees "no generation call" for these languages (see the branch near
	// declineTurn below for where this is actually acted on).
	// (CUR-742)
	// Gated behind lowResourceLanguageFallbackEnabled(), default off — the messages
	// themselves are machine-translation-sourced and, per this file's own header, not yet reviewed by a
	// speaker of any of the three languages. Off means every match falls through to `else` below (the
	// normal generation path) exactly as it did before this feature existed — an accepted false negative,
	// not a new gap this introduces.
	// (CUR-742/CUR-913)
	// Shown at most once per conversation. The notice offers to try anyway, so the next message
	// is the person's answer to that offer and gets a real attempt. (CUR-1841)
	const languageFallback =
		lowResourceLanguageFallbackEnabled() && !lowResourceNoticeAlreadyShown(messagesForPrompt)
			? detectLowResourceLanguage(userTextToScreen)
			: null;
	// ── The per-turn policy: resolved ONCE here, then CARRIED ───────────────────────────────────────
	// One immutable object decides the gate's verdict source, the shadow's suppression, both
	// output-moderation call sites, and the persona's stated screening posture. No consumer re-reads
	// the flag or re-evaluates output enablement — a mid-turn flag refresh cannot split the turn
	// across two policies.
	const turnPolicy = await resolveTurnPolicy();
	// Create the output-screen ledger + finalizer HERE — pre-stream, post-claim,
	// right after the policy resolves (NOT at pipeline construction). Seeded with turnStopped so a cancel
	// during the prestream phase makes the later pipeline dispatch nothing. Registered non-blocking with
	// waitUntil so the ONE output report survives a response that ends before the screens settle. Not
	// created after a terminal exit (a resumed setup then registers nothing that could hang the function).
	if (turnPolicy.outputModerationEnabled && !turnFinalized) {
		// Seeded with turnStopped: a cancel/setup-deadline during the prestream phase (before this line)
		// makes the ledger born stopped, so the pipeline dispatches and releases nothing. The start()
		// turnStopped guard below then finalizes it and never runs generation.
		outputLedger = { dispatched: [], stopped: turnStopped, released: "" };
		finalizeOutput = makeOutputFinalizer(outputLedger, messageToWriteTo.id, coopUserId);
		nodeRequestContext().waitUntil?.(finalizeOutput.settled);
	}
	// ── The ONE shared media pass ───────────────────────────────────────────────────────────────────
	// Hydrate every attached file ONCE, expand clipboard, extract+cap text, build bounded image
	// screening renditions — producing BOTH the gate's screen input and the per-message payload the
	// endpoint sends, so the gate screens EXACTLY the bytes the model receives. Kept as a PROMISE (not
	// awaited here) so the typed-text RAG/web legs below still launch immediately; the gate chains off
	// it (gate dependency: prepareTurnMedia → runInputGate). A no-file turn hits its fast path — no DB
	// read, ~0ms — so the common case pays nothing. Carried to the generation ctx so preprocessMessages
	// reuses this settled structure instead of hydrating a second time.
	//
	// prepareScreenedTurnMedia trims moderation-DECLINED turns FIRST (see its doc) so the guard-primary
	// gate screens the CURRENT turn, not the flagged history a decline leaves behind — the input-gate
	// half of the cross-turn spillage guard. The endpoint strips the same turns downstream and
	// looks its per-message media up by id, so dropping declined entries here leaves what it sends
	// aligned (a current-turn file can gain budget the trimmed history no longer spends — that same
	// text is screened, never sent-past-screened).
	const mediaPrepStart = Date.now();
	// A PDF or DOCX is read to text only when the guard screens this turn, the one path that
	// screens file text (the Coop branch screens typed text alone). (CUR-987)
	const preparedMediaPromise = prepareScreenedTurnMedia(messagesForPrompt, convId, {
		readDocuments: documentAttachmentsEnabled() && turnPolicy.useGuardPrimary,
		ownerId: conv.userId?.toString(),
		guestSessionId: conv.userId ? conv.formerGuestSessionId : conv.sessionId,
		...(faultInjection === "storage_hub_read_rate_limited" ? { fault: faultInjection } : {}),
	}).then((m) => {
		turnSpans.mediaPrepMs = Date.now() - mediaPrepStart;
		return m;
	});
	preparedMediaPromise.catch(() => {});
	// legs-start clock — retrievalMs/ragMs measure from here (invariant 8); ragMs is written by the RAG
	// promise's .then below and read by the stream at the retrieval join.
	const retrievalStart = Date.now();

	// settings.findOne — launched WITH the legs (post-claim: on the PG_POOL_MAX=1
	// connection its RTT now rides the retrieval window instead of queueing ahead of the awaited
	// conv-load/rate-limit reads). Trivially after the 401 guard, so authCondition can't throw on missing
	// locals. Detach-guard as a SEPARATE statement (invariant 6/7): do NOT bake a .catch into the promise
	// the join awaits — the join re-awaits the ORIGINAL promise so a real settings DB error still lands in
	// the stream catch exactly as today. The .then stamps the span WITHOUT swallowing (a rejected findOne
	// skips it → the join rejects).
	const settingsStart = Date.now();
	const settingsPromise = collections.settings.findOne(authCondition(locals)).then((r) => {
		turnSpans.settingsMs = Date.now() - settingsStart;
		return r;
	});
	settingsPromise.catch(() => {});

	// The safety GATE owns the ENTIRE gate span, timed at promise settlement: both legs, the
	// gateMs stamp, and the [moderation] timing log all run INSIDE runInputGate (see inputGate.ts),
	// settling with { verdict, childSafety, contentPolicy, gateMs, gateSource }. The stream's
	// moderation branch consumes the settled bundle without re-running any check, so gateMs can neither
	// lose the child/content span nor absorb the stream's join-idle time. Which source screens —
	//   coop (flag OFF): ONE Coop /content submit, verdict-reusing owner-points (unchanged);
	//   guard (flag ON): ONE Shieldstral screening operation, ZERO sync Coop calls —
	// is decided by the CARRIED turnPolicy, resolved once above. The gate takes
	// the shared GuardScreenInput (typed text + extracted file text + image units), so it screens the
	// exact media the model receives; the Coop branch inside reads typedTurnText only.
	// The gate promise is obtained THROUGH withGuardShadow: it launches the Shieldstral shadow probe
	// BESIDE the gate (fire-and-forget, measure-only) and returns this gate promise UNCHANGED. Routing
	// through the seam (rather than a bare launch call) is what makes "shadow beside the gate, never in
	// its path" a TESTED invariant — guardShadow.spec.ts's isolation tests go red if it is ever
	// awaited/joined. Off unless the `guard-shadow` flag is ON and GUARD_SHADOW_URL is set — and
	// SUPPRESSED via the carried policy when guard-primary already screens this turn, so both flags ON
	// still runs exactly one screening operation. Chained off the media pass (the same settled
	// GuardScreenInput feeds runInputGate AND the shadow — one object, never two screenings).
	// The guard also screens the system text the caller wrote (the conversation's preprompt or
	// their Personalization), since it shapes this turn as much as the typed message does. A settings
	// read that fails leaves Personalization out here; the stream's own join on settingsPromise then
	// fails the turn, so nothing is generated past an unscreened instruction.
	// Where a multi-chunk guard screen has got to, read by the stream's heartbeat for the "Checking
	// safety" line (CUR-3749). Stays at 0 parts for a one-chunk screen and for Coop. (CUR-3528)
	const screenProgress = { part: 0, parts: 0 };
	const gatePromise = Promise.all([preparedMediaPromise, settingsPromise.catch(() => null)]).then(
		([preparedMedia, gateSettings]) => {
			// A newest message over the model's context on its own is refused before the screen, with the
			// endpoint's own error, so the stream's catch writes the same reply and no guard call is spent.
			const newest = userMessageId ? preparedMedia.messages.get(userMessageId) : undefined;
			const tooLong = overContextBeforeScreen(
				newest?.finalText ?? userTextToScreen,
				newest?.images.length ?? 0,
				contextTokensFor(model.id)
			);
			if (tooLong) {
				logger.warn(
					{ leg: "fit-history", model: model.id, requiredTokens: tooLong.requiredTokens, contextTokens: tooLong.budgetTokens },
					"[fit-history] newest message alone is over the context; refused before the input screen"
				);
				throw tooLong;
			}
			const media = {
				...preparedMedia,
				screen: withClientInstructions(
					preparedMedia.screen,
					clientAuthoredInstructions(conv.preprompt, model.preprompt, personalInstructionsFrom(gateSettings))
				),
			};
			// Zentropi judges this turn's input screen when its typed text is am/yo/ha/sw and the
			// flag is on; a near-miss read keeps Shieldstral and adds Zentropi as a second opinion (CUR-4423). (CUR-4340)
			// With s1-safety-judge on, Zentropi S1 judges every text chunk and the CoPE routing is
			// not used. A stub or fault-injection turn keeps today's judges, so each fault still means what
			// its spec says. (CUR-4527)
			const routedJudges = screenStub
				? {}
				: inputJudgesFor(media.screen.typedTurnText, logger, { allowS1: !faultInjection });
			return withGuardShadow(
			runInputGate(
				{
					input: media.screen,
					userId: coopUserId,
					useGuardPrimary: turnPolicy.useGuardPrimary || screenStub,
				},
				screenStub
					? { getGuardVerdict: stubGuardVerdict }
					: {
							guardDeps: {
								enabledFlags: inputScreenFlags(),
								// The one screen that counts distress hits, so the daily count is messages (CUR-3915).
								countLogHits: countGuardHitsSafe,
								// An agent or local turn gets no screen allowance, so its screen keeps the old cap.
								deadlineCapMs: screenDeadlineCapMs(turnGenerationTimeout(model.id, isAgentTurn).effectiveMs),
								onProgress: (part: number, parts: number) => {
									screenProgress.part = part;
									screenProgress.parts = parts;
								},
								...routedJudges,
								...(faultInjection === "input_screen_unfinished" ? { abortAfterChildTier: true } : {}),
								// The real input screen with a guard that never answers, as output_guard_unreachable
								// does for the output screen. (CUR-4101)
								...(faultInjection === "input_guard_unreachable" ? { judge: unreachableGuardJudge } : {}),
								...(faultInjection === "input_screen_declines_rule" ? { judge: harassmentRuleJudge } : {}),
							},
						}
			),
			media.screen,
			{ suppressed: turnPolicy.useGuardPrimary }
		);
		}
	);
	gatePromise.catch(() => {});
	// A screen over a long history read several guard chunks; the ones past the first count
	// against this session's and network's per-minute limit, which every instance shares. (CUR-3532)
	void runInBackground(
		gatePromise.then((g) =>
			chargeScreeningCost({ userId, clientAddress: getClientAddress(), guardChunks: g.guardChunks ?? 0 })
		)
	);

	// ── Coop as the REVIEW plane: hit-only /report  ──────────────────────
	// Under guard-primary, Coop is a review platform, not a second detector — it receives ONLY turns
	// that fired a detection rule (block or log), never a clean turn. ONE hook on the settled gate
	// bundle covers every path identically (allowed, declined, aborted, language fallback) —
	// declineTurn/recordAllowed do NOT report, because an aborted or fallback turn skips them. The WHOLE chain (gate -> report) is handed to
	// runInBackground at CREATION, so waitUntil holds the function open from before the gate settles: a
	// response that ends before the gate resolves still reports. AWAITED, not voided — on the waitUntil
	// path runInBackground returns as soon as it schedules (no TTFT cost); on Vercel with NO context it
	// awaits inline by design (the guarantee that branch exists for). runInBackground swallows the
	// rejection, and reportHitToCoop never rejects, so this await can never fail the turn. Post-claim by
	// construction (the whole block runs after the W2 claim). The Coop branch leaves g.hits undefined
	// (Coop already screened sync), so this fires only on the guard branch.
	await runInBackground(
		gatePromise.then((g) =>
			g.gateSource === "guard" && g.hits?.length && userMessageId
				? reportHitToCoop({
						surface: "chat-input",
						messageId: userMessageId,
						text: userTextToScreen,
						hits: g.hits,
						subjectId: coopUserId,
					})
				: undefined
		)
	);

	// ── PARALLELISM (TTFT): start the independent retrieval work CONCURRENTLY with the safety gate. RAG,
	// the always-web retrieval, and the billing-org resolve don't depend on the moderation verdict, so
	// overlapping them with the ~5–8s gate removes that whole span from TTFT on the common allow path
	// (rather than serial pre-screen → RAG). Safe: RAG + the no-history web retrieval are read-only retrieval on
	// the unscreened turn, the answer is still gated by moderation in start() below, and on a (rare)
	// decline the decline path drops the provenance (`delete messageToWriteTo.rag`); the promises settle
	// unused there — best-effort, no harmful side effects.
	// Record RAG's TRUE wall-clock when it resolves (it runs concurrently with the gate, so measuring at
	// the post-gate await point would inflate ragMs by the overlap).
	const ragPromise =
		userTextToRag && ragPreTurn
			? maybeRagGrounding(userTextToRag, locals, visitorSourceCount, turnSpans, ragWorkspace).then((r) => {
					ragMs = Date.now() - retrievalStart;
					return r;
				})
			: Promise.resolve(null);
	ragPromise.catch(() => {});
	// Whether that promise really queries our document stores, for the live status line (CUR-2223).
	const documentsSearched = !!userTextToRag && ragPreTurn && ragWillSearch(userTextToRag);
	// Turn-quality signals for the web step, computed ONCE here (pure/deterministic) and reused by the
	// concurrent always-launch below, the auto path, and the generation ctx (plan MINOR-2):
	//   unservableLive — a structurally-LIVE ask (live scores/prices/weather/breaking news) the open
	//     encyclopedic/scholarly engines can't serve; force skip-grounding even for manual "always" so
	//     the turn is never stamped grounded on a topically-relevant but stale page.
	//   recencyHint — cheap "wants current info" signal; feeds webSearchPlan, decideWebSearch, and #4.
	//   searchCtx — recency + raw-text intent signals for openSearch's engine routing / recency prior.
	//   searchHistory — prior turns for coreference rewriting of a follow-up ("…about it").
	const unservableLive = !!userTextToRag && isUnservableLiveQuery(userTextToRag);
	const recencyHint = !!userTextToRag && isRecencyQueryDenoised(userTextToRag);
	const searchCtx = {
		recency: recencyHint,
		latest: !!userTextToRag && asksForTheLatest(userTextToRag),
		rawSignals: userTextToRag ? classifyQueryIntent(userTextToRag).signals : undefined,
	};
	const searchHistory = [...messagesForPrompt]
		.filter(
			(m) => (m.from === "user" || m.from === "assistant") && (m.content ?? "").trim().length > 0
		)
		.slice(0, -1)
		.slice(-4)
		.map((m) => ({
			from: m.from as "user" | "assistant",
			content: (m.content ?? "").slice(0, 600),
		}));
	// PARALLELISM (TTFT §5.1): "always" mode runs the web UNCONDITIONALLY — webSearchPlan returns "run"
	// from mode + unservableLive alone, INDEPENDENT of community sufficiency — so start its RETRIEVAL
	// here, concurrently with the safety gate + RAG, instead of serialising the ~4s web round-trip after
	// RAG just to learn the citation offset. The hits come back UNNUMBERED and are numbered community-
	// first at the join in start() (numberWebSources), so nothing is ever committed to [1..m] that could
	// collide with community [1..k]. Same safety posture as the concurrent RAG above: read-only retrieval
	// on the unscreened turn, gated by moderation below; on a decline the promise settles unused and the
	// decline path drops the provenance. auto/off stay community-DEPENDENT and are decided after RAG
	// resolves (in start()).
	// !isAgentTurn: the agent endpoint never reads this (CUR-574, see the isAgentTurn declaration above) —
	// launching it anyway pays for a real web round-trip nobody sees.
	const webAlways =
		retrievesPreTurn &&
		!!userTextToRag &&
		webSearchPlan({
			mode: webSearchMode,
			communitySufficient: false,
			recencyHint,
			unservableLive,
		}) === "run";
	// PRE-LAUNCH only when NO coreference rewrite is needed (empty history). runWebRetrieval WITH history
	// calls contextualizeQuery — a GENERATIVE model call that rewrites the user's turn — which must NOT
	// run before the safety gate clears it ("screen every message before it reaches the model"). Those
	// turns take the post-gate always path in start() (the rewrite runs AFTER moderation; same community-
	// first numbering). The no-history retrieval that overlaps the gate here does the engine fan-out + the
	// cross-encoder relevance rerank — the SAME non-generative posture as the concurrent RAG above,
	// which ALREADY reranks the user's query pre-gate
	// (rag/index.ts). No GENERATIVE model sees the turn before moderation, and on a decline this promise
	// settles unused (its would-be sources are dropped). RAG stays concurrent regardless.
	// Why the pre-launched leg produced no outcome, if it failed, so the answer can say so. (CUR-4091)
	const webRetrievalFailure: { why?: WebSearchFailure } = {};
	const webRetrievalPromise: Promise<WebRetrieval | undefined> | undefined =
		webAlways && searchHistory.length === 0
			? runWebRetrieval(userTextToRag, {
					locals,
					ctx: searchCtx,
					hang: faultInjection === "web_search_hangs",
					onFailed: (why) => (webRetrievalFailure.why = why),
				})
			: undefined;
	webRetrievalPromise?.catch(() => {});

	// The whole pre-stream stretch (promptedAt → here) — the dark span §A collapses. Stamped now, folded
	// into message.timings via the turnSpans spread, and logged in the [prestream] line at the stream join.
	// On the prestream-events path this runs inside the already-open stream, so it measures the same
	// promptedAt → chain-done stretch either way.
	turnSpans.preStreamMs = Date.now() - promptedAt.getTime();

	return {
		conv,
		loadedConv,
		model,
		isAgentTurn,
		agentAttach,
		harness,
		messageToWriteTo,
		// Auto's kept choice, so the endpoint below can give up sooner on a silent pick. (CUR-4384)
		autoRouted,
		messagesForPrompt,
		generationId,
		webSearchMode,
		speakAll,
		speakMode,
		// The post-claim prelaunches + their plumbing, joined in order inside stream start().
		turnSpans,
		turnPolicy,
		writeChain,
		userMsgPersist,
		settingsPromise,
		preparedMediaPromise,
		gatePromise,
		screenProgress,
		ragPromise,
		webRetrievalPromise,
		webRetrievalFailure,
		webAlways,
		documentsSearched,
		unservableLive,
		recencyHint,
		searchCtx,
		searchHistory,
		retrievalStart,
		userTextToScreen,
		messageLanguagePromise,
		declineLanguagePromise,
		supportSignalPromise,
		coopUserId,
		userTextToRag,
		visitorSourceCount,
		languageFallback,
		// What came with the message, by kind, so the search decider judges the question with it. (CUR-3192)
		turnAttachmentKinds: uploadedFiles.map(
			(f): AttachmentKind =>
				f.mime.startsWith("image/") ? "image" : f.mime === CLIPBOARD_MIME ? "pasted text" : "document"
		),
	};
	};

	let doneStreaming = false;
	let clientDetached = false;
	// Set once the turn has been finalized (terminal update emitted, persist/finalize done or
	// bounded-attempted). After this, update() is a no-op and the in-work persist/finalize tail
	// returns without writing: a generation abandoned by the hard deadline may resume long after
	// the stream closed, and it must not mutate the persisted message or trigger detached persists.
	let turnFinalized = false;
	// Set when the EMERGENCY persist (hard-deadline path) missed its budget: its write-chain link
	// may still be queued behind the wedged link that caused the timeout, and by then the W2 id has
	// been marked re-claimable — if the chain later unwedges, that stale full-doc write must NO-OP
	// instead of clobbering a retried/newer turn.
	let persistAbandoned = false;
	// RAG's true wall-clock, written by the RAG leg's .then (launched in runPrestream) and read by the
	// stream at the retrieval join + the first-token finalizer. POST scope so both closures share it.
	let ragMs: number | undefined;
	// Assigned once the chain has run (it closes over the chain's `conv`); until then a client
	// disconnect has nothing to persist. See cancel() below.
	let persist: (() => Promise<void>) | null = null;
	// The output-review lifetime. `turnStopped` is set the instant the turn is
	// cancelled or a setup deadline fires, EVEN BEFORE the ledger exists, and SEEDS the ledger's stopped
	// flag so a late-created pipeline dispatches nothing. `outputLedger` + `finalizeOutput` are created in
	// runPrestream (after resolveTurnPolicy) and live here so cancel()/the hard deadline can reach them.
	let turnStopped = false;
	let outputLedger: OutputScreenLedger | undefined;
	let finalizeOutput: OutputFinalizer | undefined;

	// Opt-in from the client (see fetchMessageUpdates): only a client that KNOWS the chain's outcome
	// may arrive as in-stream events gets the early-flush path. Everything else — old clients still
	// running the previous bundle for days in a pinned tab — gets the legacy shape, where failures
	// are HTTP statuses and the Response is only built after the chain succeeds.
	const prestreamEvents = request.headers.get(PRESTREAM_EVENTS_HEADER) === "1";

	let legacyChain: Awaited<ReturnType<typeof runPrestream>> | undefined;
	if (!prestreamEvents) {
		try {
			// Same chain backstop as the prestream path: a legacy request awaits the chain BEFORE any
			// Response exists, so a hung step rode the invocation to the 300s platform kill (a raw
			// FUNCTION_INVOCATION_TIMEOUT). Bound it and return a clean, retryable 504 instead.
			const chainWork = runPrestream();
			chainWork.catch(() => {}); // a late rejection must never surface as an unhandled rejection
			legacyChain = await raceGenerationDeadline(chainWork, PRESTREAM_CHAIN_DEADLINE_MS);
		} catch (e) {
			// Settle the output lifetime for EVERY legacy setup exit — conflict,
			// deadline, or an unexpected post-ledger error — before any branch returns or rethrows, or a
			// registered finalizeOutput.settled would hang. turnFinalized also STOPS an abandoned runPrestream
			// from creating a late ledger whose finalizer nothing would call.
			turnStopped = true;
			turnFinalized = true;
			if (finalizeOutput) await finalizeOutput();
			if (e instanceof GenerationConflictSignal) {
				// NB: `json` from @sveltejs/kit is shadowed by a local `json` (the parsed form field) in
				// runPrestream's scope, so this 409 Response was always built directly.
				return new Response(JSON.stringify(e.info), {
					status: 409,
					headers: { "content-type": "application/json" },
				});
			}
			if (e instanceof GenerationDeadlineExceeded) {
				logger.error(e, "[prestream] legacy chain exceeded the hard deadline");
				return new Response(
					JSON.stringify({ message: "The request took too long to respond. Please try again." }),
					{ status: 504, headers: { "content-type": "application/json" } }
				);
			}
			throw e; // HttpError → its status; anything else → SvelteKit's generic 500 (as before)
		}
	}
	const abortRegistry = AbortRegistry.getInstance();

	// Settle review work even when stream setup fails outside generationWork's cleanup.
	const withOutputCleanup = (
		start: (controller: ReadableStreamDefaultController<string>) => Promise<void>
	) => async (controller: ReadableStreamDefaultController<string>): Promise<void> => {
		try {
			await start(controller);
		} catch (error) {
			turnStopped = true;
			turnFinalized = true;
			await finalizeOutput?.();
			throw error;
		}
	};

	// we now build the stream
	const stream = new ReadableStream({
		start: withOutputCleanup(async (controller) => {
			const conversationKey = convId.toString();

			// Prestream-events path: the Response is already on the wire (this start() runs at stream
			// construction, before POST returns), so prove liveness IMMEDIATELY and then run the chain
			// HERE, emitting its outcome as events. The raw enqueues bypass update() by necessity —
			// update() closes over the chain's message/model, which don't exist yet — with the same
			// detach guard update() uses.
			let chain = legacyChain;
			if (!chain) {
				const enqueueRaw = (u: MessageUpdate) => {
					if (clientDetached) return;
					try {
						controller.enqueue(JSON.stringify(u) + "\n");
					} catch {
						clientDetached = true;
					}
				};
				const startingKeepAlive: MessageUpdate = {
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.KeepAlive,
					message: PRESTREAM_STARTING_PHASE,
				};
				// Synchronous, before any await: this is the byte that flushes the headers — the whole
				// point of the prestream-events path. The interval keeps the client's silence-based
				// first-token watchdog fed through a legitimately slow chain (resolveAgentRoute alone
				// can wait ~20s), the same job retrievalHeartbeat does for the retrieval phase.
				enqueueRaw(startingKeepAlive);
				const startingHeartbeat = setInterval(
					() => enqueueRaw(startingKeepAlive),
					PRESTREAM_HEARTBEAT_MS
				);
				try {
					// Bound the WHOLE chain, not just generation (generationWork's race is further below and
					// a chain that HANGS never reaches it). On timeout the chain promise is abandoned and
					// prestreamFailureUpdate maps GenerationDeadlineExceeded to a retryable 504. The abandoned
					// promise may still finish claim/persist under a now-orphaned generationId — benign: the
					// client retries a >=500 with a FRESH id, so the stale in_flight record blocks nothing.
					const chainWork = runPrestream();
					chainWork.catch(() => {}); // a late rejection must never surface as an unhandled rejection
					// A Stop in the seconds before the question is saved hangs up the client, and (CUR-3018)
					// nothing would otherwise hold the function open for that save, or mark the answer stopped once
					// it landed, so the question would be lost or come back looking unanswered. Keep the
					// function alive until the chain settles, and save a detached turn as interrupted.
					nodeRequestContext().waitUntil?.(
						chainWork
							.then(async (c) => {
								if (!clientDetached) return;
								c.messageToWriteTo.interrupted = true;
								await c.userMsgPersist.catch(() => {});
								await c.writeChain.enqueue(() =>
									saveConversationMessages({ _id: convId }, c.loadedConv, {
										messages: c.conv.messages,
										title: c.conv.title,
										updatedAt: new Date(),
									})
								);
							})
							.catch((e) => logger.warn(e, "[prestream] saving a stopped turn failed"))
					);
					chain = await raceGenerationDeadline(chainWork, PRESTREAM_CHAIN_DEADLINE_MS);
				} catch (e) {
					// No-output exit (setup failure/timeout): settle the lifetime,
					// and set turnFinalized so an abandoned runPrestream cannot create a late ledger whose
					// finalizer nothing would call.
					turnStopped = true;
					turnFinalized = true;
					if (finalizeOutput) await finalizeOutput();
					const failure = prestreamFailureUpdate(e);
					if ((failure.statusCode ?? 0) >= 500) {
						logger.error(e, "[prestream] chain failed");
					} else if (failure.statusCode !== 409) {
						// A refusal (400/413/415/429) is delivered in-stream on a 200, so without this line
						// the logs show only a fast 200 and nothing says the send was turned away (CUR-1896).
						logger.warn(
							{ statusCode: failure.statusCode, reason: failure.message },
							"[prestream] request refused"
						);
					}
					enqueueRaw(failure);
					try {
						controller.close();
					} catch {
						// already closed/errored by a detach
					}
					return;
				} finally {
					clearInterval(startingHeartbeat);
				}
			}
			const {
				conv,
				loadedConv,
				model,
				isAgentTurn,
				agentAttach,
				harness,
				messageToWriteTo,
				autoRouted,
				messagesForPrompt,
				generationId,
				webSearchMode,
				speakAll,
				speakMode,
				turnSpans,
				turnPolicy,
				writeChain,
				userMsgPersist,
				settingsPromise,
				preparedMediaPromise,
				gatePromise,
				screenProgress,
				ragPromise,
				webRetrievalPromise,
				webRetrievalFailure,
				webAlways,
				documentsSearched,
				unservableLive,
				recencyHint,
				searchCtx,
				searchHistory,
				retrievalStart,
				userTextToScreen,
				messageLanguagePromise,
				declineLanguagePromise,
				supportSignalPromise,
				coopUserId,
				userTextToRag,
				visitorSourceCount,
				languageFallback,
				turnAttachmentKinds,
			} = chain;
			// What the arithmetic pre-pass decided, persisted beside timings on the same message. (CUR-2043)
			const turnRungs: RungStep[] = [];

			// A cancel/setup-deadline during the prestream phase
			// set turnStopped while runPrestream was still resolving, so this turn must NOT run generation —
			// otherwise it would screen, release and persist an abandoned answer. Settle the output lifetime
			// (the ledger, if created, was born stopped so it holds nothing) and close cleanly.
			if (turnStopped) {
				turnFinalized = true;
				if (finalizeOutput) await finalizeOutput();
				if (generationId) {
					await finishGeneration(generationId, "error").catch(() => {});
				}
				doneStreaming = true;
				if (!clientDetached) {
					try {
						controller.close();
					} catch {
						/* already closed by the disconnect that set turnStopped */
					}
				}
				return;
			}

			const metricsEnabled = MetricsServer.isEnabled();
			const metrics = metricsEnabled ? MetricsServer.getMetrics() : undefined;
			const metricsModelId = model.id ?? model.name ?? conv.model;
			const metricsLabels = { model: metricsModelId };
			if (metricsEnabled && metrics) {
				metrics.model.messagesTotal.inc(metricsLabels);
			}

			const persistConversation = async () => {
				const messagesForSave = conv.messages.map((msg) => {
					// A message with nothing to compress goes back as loaded. Giving it `updates: []`
					// would read as this turn changing it, and another tab's in-flight answer would be saved
					// back as the empty placeholder this turn loaded. (CUR-2806)
					if (!msg.updates?.length) return msg;
					const filteredUpdates =
						msg.updates
							?.filter(
								(u) =>
									!(
										u.type === MessageUpdateType.Status &&
										u.status === MessageUpdateStatus.KeepAlive
									)
							)
							.map((u) => {
								if (u.type !== MessageUpdateType.Stream) return u;
								// Preserve existing len if already compressed, otherwise compute from token
								const len = u.len ?? (u.token ?? "").length;
								// store a lightweight marker to preserve ordering without duplicating content
								return {
									type: MessageUpdateType.Stream,
									token: "",
									len,
								} satisfies MessageStreamUpdate;
							}) ?? [];

					return { ...msg, updates: filteredUpdates };
				});

				// Route through the per-request write chain (invariant 3) so this whole-document write never
				// races the user-msg persist / saveTitle. Best-effort: a transient DB failure at persist time
				// must NOT throw out of the stream's start()/finally (which would error the stream AFTER a
				// good answer already reached the client, and lose the turn on reload). Log and move on — the
				// answer stays visible in-session; the generation idempotency record (finishGeneration below)
				// is the durable retry seam. The internal try/catch means the chain link never rejects;
				// awaiting the enqueued link flushes it (the terminal persist is awaited before
				// finishGeneration — invariant 4).
				await writeChain.enqueue(async () => {
					// Abandoned emergency persist (see persistAbandoned): the hard deadline gave up on this
					// link while the chain was wedged and already released the W2 id — running it late could
					// clobber a retried/newer turn with this stale snapshot.
					if (persistAbandoned) return;
					try {
						await saveConversationMessages({ _id: convId }, loadedConv, {
							messages: messagesForSave,
							title: conv.title,
							updatedAt: new Date(),
						});
					} catch (err) {
						logger.error(
							err,
							"[persist] failed to save conversation (answer shown in-session, not persisted)"
						);
					}
				});
			};
			persist = persistConversation;

			const ctrl = new AbortController();
			abortRegistry.register(conversationKey, ctrl);

			// Cross-pod and pre-first-token abort path. The in-process registry
			// only works when the stop request lands on this pod, and the cached
			// AbortedGenerations map is only consulted between tokens — useless
			// while awaiting the first token of a slow (e.g. reasoning) model.
			// Poll the marker collection directly and abort the upstream request
			// as soon as a stop is observed. Pre-flight deleted any stale marker,
			// so marker presence means a stop for this generation.
			const abortMarkerWatcher = setInterval(() => {
				collections.abortedGenerations
					.findOne({ conversationId: convId })
					.then((marker) => {
						// Only a marker meant for THIS turn aborts it. A marker carrying a DIFFERENT
						// generationId is a prior turn's stop that its own (already-finished) generation
						// never consumed — a finished generation only deletes the marker when abortedByUser
						// — and the pre-flight preserves markers younger than the grace window, so a bare
						// presence-abort would kill this fresh turn near-instantly. A marker with no
						// generationId is a legacy/bodyless stop → keep the presence-abort for it.
						const meantForThisTurn =
							!marker?.generationId || !generationId || marker.generationId === generationId;
						if (marker && meantForThisTurn && !ctrl.signal.aborted) {
							logger.info(
								{ conversationId: conversationKey },
								"Stop marker observed; aborting generation"
							);
							ctrl.abort();
						}
						if ((marker && meantForThisTurn) || ctrl.signal.aborted) {
							clearInterval(abortMarkerWatcher);
						}
					})
					.catch(() => {
						// transient DB error; the next tick retries
					});
			}, 300);

			const state = createStreamState();
			let abortedByUser = false;
			let hasError = false;
			// Declines are their own terminal outcome (CUR-89). Without that, a turn the safety gate
			// REFUSED would be indistinguishable from one that answered: it aborts nothing, is admitted, does
			// not time out and does not error, so the branch below would compute `complete`. That would hide the one
			// failure mode CUR-35 exists to catch — Coop fail-CLOSING checkChildSafety so every turn
			// declines, presenting as the assistant refusing users rather than as a failure — from
			// any consumer of this log line, including a rate alert on non-`complete` outcomes.
			//
			// `declineKind` carries WHICH gate refused, because the alerting question differs per kind:
			// a child_safety spike is the failure signal, content_policy is ordinary moderation.
			// `declinedAt` separates the pre-model gate from the output screen — an output
			// decline means the model RAN, so its timings mean something different.
			let declineKind: ModerationKind | null = null;
			let declinedAt: "input" | "output" | null = null;
			// Server-side generation watchdog: bound the whole turn's wall-clock UNDER the platform function
			// limit so a hung/cold model lane aborts into the catch below (a clean, retryable Status=Error)
			// instead of the invocation being KILLED at that limit. A platform kill runs no
			// catch/finally, so no terminal update is persisted and the client spins forever — the
			// cold-lane "503 → infinite spinner" failure. Distinct from a user stop via `timedOut`, so the
			// catch surfaces it as a retryable error, not an "interrupted" partial.
			//
			// Env-tunable, CLAMPED to the deadline ladder. These change at deploy time without a code change, so nothing
			// in CI can guard their ordering against the client-side staleness/eviction rungs — the guard
			// has to be here, at the effective read site. An over-large value degrades to a shorter turn
			// (visible, retryable) instead of a live turn declared dead mid-flight (invisible,
			// unretryable). See $lib/chat/utils/deadlineLadder.
			//
			// SPLIT BY TURN KIND. An agent turn and an ordinary turn share nothing on this axis: ordinary
			// turns top out at genElapsedMs ~22s, while a verified agent trial runs 32–180s
			// because the task is 13–26 sequential model calls (CUR-144). One number cannot serve both —
			// sized for the agent it lets a hung ordinary turn hold a spinner ~3× longer for no gain,
			// and sized for ordinary it kills agent work that is already finished and verified.
			// `model` is read AFTER agent routing reassigned it (~line 302), so this reflects what will
			// actually be generated against, not what the conversation had selected.
			//
			// ⚠️ The ladder's `gen + grace < stale` invariant assumes the `updatedAt` write above (the
			// user-message persist, ~line 350) is effectively the last act of the prestream chain — every
			// await between it and this watchdog arm is inside an unawaited closure, so the residual is
			// ~0. Do not introduce an awaited step between those two points without revisiting the clamp.
			let timedOut = false;
			/** The watchdog ended a turn whose model never sent a token (watchdogCountsTowardBusy). (CUR-4345) */
			let watchdogModelSilent = false;
			// Anchor for the watchdog's OWN budget. genTimeoutMs is measured from here, so this is the
			// clock to report against it in the terminal turn log — not promptedAt, which also carries
			// the prestream chain.
			const genWatchdogArmedAt = Date.now();
			// isAgentTurn is computed once inside runPrestream (needed there for the RAG/web-search
			// gate, CUR-574) and destructured off `chain` above, not redeclared here.
			//
			// A local (LAN/self-hosted) model gets its OWN, longer default (CUR-1194 timeout audit) —
			// never the primary-gateway path, so ordinary/agent turns are byte-for-byte unaffected. `model`
			// here is the same post-agent-routing binding the comment above already relies on, so this
			// reflects what will actually be generated against. Mutually exclusive with isAgentTurn: the
			// agent is a distinct model (`potluck-agent`), never a `local:*` id.
			const isLocalModel = isLocalModelId(model.id);
			const genTimeout = turnGenerationTimeout(model.id, isAgentTurn);
			// Read only under the fault that needs it, so no other turn waits on a flag poll here.
			if (faultInjection === "primary_lane_hangs") await ensureFlagsPolled();
			const genTimeoutMs = watchdogDeadlineMs(genTimeout.effectiveMs, faultInjection, {
				isAgentTurn,
				silentLaneFailover:
					faultInjection === "primary_lane_hangs" &&
					flagEnabledOr(FAILOVER_ON_SILENT_LANE_FLAG, () => false),
			});
			if (genTimeout.clamped)
				logger.warn(
					{
						conversationId: conversationKey,
						// Name the knob that is actually wrong — with three of them, "GENERATION_TIMEOUT_MS"
						// on every clamp would send an operator to edit one they didn't set.
						envVar: isAgentTurn
							? "AGENT_GENERATION_TIMEOUT_MS"
							: isLocalModel
								? "LOCAL_GENERATION_TIMEOUT_MS"
								: "GENERATION_TIMEOUT_MS",
						genTimeoutRequestedMs: genTimeout.requestedMs,
						genTimeoutEffectiveMs: genTimeoutMs,
						maxSafeGenTimeoutMs: MAX_SAFE_GENERATION_TIMEOUT_MS,
					},
					"generation timeout exceeds the deadline ladder — clamped"
				);
			// How long a stretch with NO new content token is tolerated before this counts as a
			// stall, distinct from genTimeoutMs (the TOTAL backstop below). Clamped to genTimeoutMs itself —
			// a silence window larger than the total cap can never fire first, which would make it a
			// dead knob rather than an unsafe one, but still worth flagging if someone sets it that way. (CUR-58)
			// A model with its own watchdog floor gets it for the silence window too, since before
			// the first token the two watch the same wait. (CUR-4403)
			const silenceTimeout = withModelFloor(
				resolveGenerationTimeoutMs(Reflect.get(config, "SILENCE_TIMEOUT_MS"), DEFAULT_SILENCE_TIMEOUT_MS),
				isAgentTurn || isLocalModel ? null : generationTimeoutMsFor(model.id)
			);
			const silenceTimeoutMs = Math.min(silenceTimeout.effectiveMs, genTimeoutMs);
			if (silenceTimeout.effectiveMs > genTimeoutMs)
				logger.warn(
					{
						conversationId: conversationKey,
						silenceTimeoutRequestedMs: silenceTimeout.effectiveMs,
						genTimeoutMs,
					},
					"SILENCE_TIMEOUT_MS exceeds this turn's total generation cap — clamped to it, so it can never fire before the backstop does"
				);
			// Shared by both triggers so the two only ever differ in WHEN they fire, never in HOW —
			// same abort, same terminal log shape, one extra field naming which one it was.
			const fireStall = (trigger: "silence" | "total") => {
				// Only fire on a genuine STALL: if the final answer already streamed (we're just draining
				// trailing usage/accounting chunks past the deadline), do NOT abort — that would clobber a
				// good, fully-delivered answer with an error status. The watchdog exists for the hang, not
				// for a slow-but-complete turn.
				if (ctrl.signal.aborted || state.finalAnswerReceived) return;
				timedOut = true;
				// Decided before the abort, which a visitor's Stop never reaches (the guard above). (CUR-4345)
				watchdogModelSilent = watchdogCountsTowardBusy({
					updates: messageToWriteTo?.updates,
					generationUpdatesFrom,
					firstTokenAt: state.firstTokenAt,
					faultInjected: faultInjection !== null,
					isAgentTurn,
					isLocalModel,
				});
				logger.warn(
					{ conversationId: conversationKey, genTimeoutMs, silenceTimeoutMs, trigger, modelSilent: watchdogModelSilent },
					"Generation watchdog fired — aborting stalled generation as an error"
				);
				if (watchdogModelSilent) void noteFailed(model.id);
				// The reason tells the endpoint the watchdog ended the turn, not a Stop. (CUR-4660)
				ctrl.abort(new GenerationWatchdogAbort());
			};
			// TOTAL backstop — fires regardless of activity, unchanged from before CUR-58. Without this a
			// lane emitting one token every 20s would reset the silence timer forever and ride silently to
			// the platform kill (PLATFORM_MAX_DURATION_MS) with no terminal write.
			//
			// Its clock starts when the input screen ends (CUR-3749). A 100k paste screens for up to a minute
			// or more, and counting that against genTimeoutMs would leave the model no time once it was allowed.
			// screenAllowanceMs keeps screen + generation inside MAX_SAFE, so the ladder still holds; an
			// agent or local turn, already at MAX_SAFE, gets no extension. Settled from the gate promise
			// itself, so a path that never joins the gate still pins the extension.
			//
			// An open confirm card (state.awaitingConfirmation) holds this clock too, inside the
			// same room under MAX_SAFE, so a person deciding is not counted as generation time. (CUR-3983)
			const genDeadline = new ScreenAwareDeadline(
				genTimeoutMs,
				screenAllowanceMs(genTimeoutMs),
				Date.now,
				Math.max(0, MAX_SAFE_GENERATION_TIMEOUT_MS - genTimeoutMs)
			);
			let screenSettled = false;
			const settleScreen = () => {
				screenSettled = true;
				genDeadline.screenSettled();
			};
			gatePromise.then(settleScreen, settleScreen);
			// A turn still writing its answer when the cap arrives is a slow lane, not a stall.
			// It gets the rest of the ladder's room, once, and the silence watchdog below still ends it if
			// the tokens stop. Every timer on genDeadline re-arms, the hard-unwind race included. (CUR-4009)
			let cancelTotalTimer = () => {};
			const onTotalDeadline = () => {
				if (
					!ctrl.signal.aborted &&
					!state.finalAnswerReceived &&
					isStillStreaming({
						now: Date.now(),
						lastTokenAt: state.lastTokenTimestamp?.getTime(),
						lastModelOutputAt: state.lastModelOutputAt?.getTime(),
					})
				) {
					const addedMs = genDeadline.extendWhileStreaming();
					if (addedMs > 0) {
						logger.info(
							{ conversationId: conversationKey, genTimeoutMs, addedMs },
							"[watchdog] total cap reached while still streaming — extended to the ceiling"
						);
						cancelTotalTimer = genDeadline.schedule(onTotalDeadline);
						return;
					}
				}
				fireStall("total");
			};
			cancelTotalTimer = genDeadline.schedule(onTotalDeadline);
			const cancelGenWatchdog = () => cancelTotalTimer();
			// PRIMARY trigger — polls state.lastActivityAt (streamUpdate.ts's reducer, bumped on every
			// event it processes — CUR-1204) rather than resetting a timer per token, so a real stall is
			// caught the moment silenceTimeoutMs is crossed instead of waiting for the fixed total cap —
			// the gap CUR-58 exists to close. Deliberately NOT state.lastTokenTimestamp: that field is
			// scoped to real content tokens for the inter-token-latency metric, and stays blind to an
			// agent turn's RouterMetadata heartbeat / AgentStep / WritePolicy narration — all real proof
			// the generation is alive, none of them content. Falls back to genWatchdogArmedAt before the
			// first event arrives, matching the "never started" case (CUR-58:
			// every real firing was exactly this — no first token, ever).
			const silenceWatchdog = setInterval(() => {
				if (ctrl.signal.aborted || state.finalAnswerReceived) return;
				const lastActivityAt = state.lastActivityAt?.getTime() ?? genWatchdogArmedAt;
				// An open agent-confirm card produces zero tokens by design while a human
				// decides — isSilentStall reads state.awaitingConfirmation so that wait is never treated
				// as the hang this watchdog exists to catch. The TOTAL backstop below is untouched and
				// still catches a confirm nobody ever answers. (CUR-1085)
				if (
					isSilentStall({
						now: Date.now(),
						lastActivityAt,
						silenceTimeoutMs,
						awaitingConfirmation: state.awaitingConfirmation || state.waitingForSandbox,
					})
				)
					fireStall("silence");
			}, SILENCE_CHECK_INTERVAL_MS);
			// Heartbeat through the overlapped DB joins, screening, retrieval and generation. Declared
			// here so the outer finally clears it on every error/abort; generationWork starts it.
			let retrievalHeartbeat: ReturnType<typeof setInterval> | undefined;
			// Retrieval phase wall-clock, captured here in start() scope so the first-token finalizer can
			// subtract it from ttftMs and report the ENDPOINT's own first-token latency (cold-start vs our
			// retrieval pipeline — the [ttft] decomposition log below).
			let totalRetrievalMs: number | undefined;
			// How many updates the turn held when retrieval ended and the model call began, so a
			// watchdog timeout can tell our own tool step stalling from the model going quiet. Unset while
			// retrieval is still running. (CUR-4107)
			let generationUpdatesFrom: number | undefined;
			// Set when the honesty guard threw the whole grounded answer away and substituted a source
			// pointer. Lives out here because the mutation is observed inside the stream callback and the
			// citation audit runs at the outcome log, and the audit is WRONG without it: the replacement
			// text lists sources as "[1] Title, [2] Title", so counting those would score our own fallback
			// copy as model compliance — the metric reading healthiest exactly when the model answered
			// worst. See citationAudit.ts.
			let guardReplacedAnswer = false;
			// Characters that survived to the final-guard stage, captured before any final-only guard
			// null when none ran. Lives out here for the same reason as guardReplacedAnswer: the value is
			// only observable inside the stream callback and the outcome log needs it. See answerLength.ts
			// for why the finished message's own length cannot stand in (CUR-443).
			let preGuardChars: number | null = null;
			// Distinguishes the two things guardReplacedAnswer/groundedHedgeMutation lump together
			// on purpose (see the comment at the assignment site) — a fresh ungrounded regen that SUCCEEDED
			// with real content is not the same user experience as buildGroundedHedgeReplacement's bare
			// sources pointer, even though both correctly count as "not the model's grounded answer" for
			// the citation audit. Only this flag feeds the outcome log's `empty` rung. (CUR-192)
			let answerRecoveredByRegen = false;
			// gateMs is captured in start() scope so the first-token finalizer can persist it on
			// message.timings — a DURABLE, queryable phase split (no tailing ephemeral platform logs). It is
			// assigned from the settled gate bundle at the gate join below (the gate promise, launched in
			// runPrestream, computes it at its own settlement). ragMs (POST scope) and the turnSpans sink /
			// retrievalStart clock (chain result) live where the legs were launched — runPrestream.
			let gateMs: number | undefined;

			messageToWriteTo.updates ??= [];
			// Whether this turn carries the Support resources card, from the guard's distress rules
			// or the multilingual signal, which can land after the answer starts. Never rejects. (CUR-4093)
			let supportVerdict: Promise<boolean> = Promise.resolve(false);
			const initialMessageContent = messageToWriteTo.content;
			const metricsCtx =
				metricsEnabled && metrics
					? { model: metrics.model, labels: metricsLabels, promptedAt }
					: undefined;

			// Capture the non-null narrowing here, at the start() body level where it still holds. The
			// nested update() closure below loses it (a known TS limitation across nested functions —
			// the original code used an in-function throw guard for the same reason).
			const message = messageToWriteTo;
			const conversation = conv;
			const activeModel = model;
			// Started now so the embedding is done by the time the search decision reads it.
			// Its one use since the provider stamp moved into X-ray (CUR-2921) is the search veto below: a
			// question about the assistant itself is answered from its own provenance, never the web.
			// Undefined when the flag is off, which keeps the classifier out of every turn. (CUR-2135)
			const readSelfIdentityVerdict =
				providerStampEnabled() && userTextToScreen
					? startSelfIdentityVerdict(userTextToScreen)
					: undefined;

			// Fire the first post-chain client-visible signal. Legacy path: this IS the first byte the
			// client ever sees ("starting" — everything before ran with no Response constructed), kept
			// verbatim for old clients. Prestream-events path: liveness was already proven by the raw
			// "starting" keepalive at stream open, so this emits the ACCEPTED marker instead — the
			// client's vet consumes it as "the chain passed; real updates follow" and never shows it.
			// -- Admission gate (per-instance concurrency cap) --
			// Decided HERE, before the accepted marker, so an at-capacity shed emits its 503 PRE-accept.
			// That routing is the whole reason the check lives here and not at generationWork: a pre-accept
			// Status/Error is read by the client's prestream vet, which retries it (retryWithBackoff,
			// status>=500) - jittered, fresh generationId, no message-tree artifacts - instead of the 503
			// landing mid-stream as a hard error toast the user must manually resend. Past the inference
			// endpoint's flat batch-region, admitting more generations just creeps everyone's TTFT; shedding
			// overflow keeps the admitted turns fast. Disabled by default (MAX_CONCURRENT_GENERATIONS<=0).
			// The slot is released in the gate block's `finally` below; generation is hard-bounded by the
			// deadline there, so a hung turn frees it within the ladder's worst case (deadlineLadder) -
				// never at the platform kill, which runs no `finally`.
			const admitted = tryAcquireGenerationSlot();
			if (!admitted) {
				hasError = true;
				logger.warn(
					{ conversationId: conversationKey, inFlight: generationInFlight() },
					"[generation] at capacity - shedding turn pre-accept as retryable 503"
				);
				// Emit the 503 in place of the accepted marker. Bound every await with the emergency budget: a
				// capacity shed fires precisely when the instance is saturated, and the DB pool is often the
				// saturated resource — an UNBOUNDED finalize/emit here could itself wedge and ride to the 300s
				// platform kill, the very failure the gate exists to prevent. 'error' leaves the W2 id
				// re-claimable so the client's retry re-runs THIS turn on a fresh instance/slot.
				await boundedSettle(
					update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						statusCode: 503,
						message: "Alpha is at capacity right now. Please try again in a moment.",
					}),
					EMERGENCY_CLEANUP_BUDGET_MS
				);
				turnFinalized = true;
				// generationWork (which normally clears these) won't run — disarm the generation watchdog AND
				// the 300ms stop-marker poll, so neither fires into a closed stream nor keeps hitting the DB
				// while we're shedding load.
				// No-output exit: generationWork never runs, so settle the output
				// lifetime here (empty ledger -> zero reports) or its registered waitUntil would hang. Bounded.
				turnStopped = true;
				if (finalizeOutput) await boundedSettle(finalizeOutput(), EMERGENCY_CLEANUP_BUDGET_MS);
				cancelGenWatchdog();
				clearInterval(silenceWatchdog);
				clearInterval(abortMarkerWatcher);
				if (generationId) {
					await boundedSettle(finishGeneration(generationId, "error"), EMERGENCY_CLEANUP_BUDGET_MS);
				}
			} else {
				void update({
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.KeepAlive,
					message: prestreamEvents ? PRESTREAM_ACCEPTED_PHASE : phaseMarker("starting"),
				}).catch(() => {});
			}

			// Thin wrapper around the event reducer: fold the event into the assistant message (see
			// $lib/chat/server/chat/streamUpdate — that's where the per-type dispatch and metrics live), then
			// do the client-facing stream plumbing the reducer is deliberately kept out of: enqueue,
			// detach detection, and detached-persist. A null result means "drop this event entirely".
			async function update(event: MessageUpdate) {
				// Hard-deadline terminal guard (see turnFinalized): an abandoned zombie generation that
				// resumes after the emergency path closed the turn must not mutate or persist anything.
				if (turnFinalized) return;
				// Recency-hedge, citation/label, URL, and source-claim honesty checks now run INSIDE
				// honestyScreenStream (per-chunk, before a token ever reaches here) — see
				// $lib/chat/server/textGeneration/honestyStream.ts. What's left at this chokepoint is only
				// the rare injection-fence leak, which stays a whole-text safety net since it's unrelated to
				// (and much rarer than) the honesty family and every FinalAnswer producer funnels through here.
				// additionally, resolve the out-of-band output-moderation carriers into the body
				// ONCE, here, after every upstream model-text guard has run and left them untouched (honesty is
				// the only one; the arithmetic guards were retired in CUR-2095). Both are mutually exclusive with the token-cap notice below (a
				// moderation-terminated turn never also needs a "ran out of tokens" notice), and each
				// deletes its carrier once resolved so the SSE line and the message.updates audit trail
				// never ship a duplicate of text already in `text`. (CUR-946)
				if (event.type === MessageUpdateType.FinalAnswer && event.declineText) {
					// Full block: reviewed static copy that never passed through generate.ts. Replace the
					// body verbatim — no fence-strip is needed for copy we authored ourselves.
					event.text = event.declineText;
					// Delete BOTH carriers, not just the resolved one: a future producer that set both must
					// not leave the unresolved field on the wire / audit record either.
					delete event.declineText;
					delete event.declineNotice;
				} else if (event.type === MessageUpdateType.FinalAnswer && event.declineNotice) {
					// Mid-stream block: event.text is the honesty-processed PREFIX, which — like
					// any screenOutputStream-composed text — bypassed generate.ts's fence-strip, so clean it
					// here. Only the prefix; the notice (reviewed, static) is exempt. Join without a stray
					// separator when the prefix is empty.
					const prefix = stripResponseTags(stripFenceTags(event.text));
					event.text = prefix.trim()
						? `${prefix.trimEnd()}\n\n${event.declineNotice}`
						: event.declineNotice;
					delete event.declineNotice;
					delete event.declineText;
				} else if (
					event.type === MessageUpdateType.FinalAnswer &&
					typeof event.text === "string" &&
					event.text
				) {
					// Injection-fence safety net (ALL turns, regardless of grounding): generate.ts already
					// strips a leaked <Q_xxxx> per-turn fence/<response> wrapper on its own happy-path
					// FinalAnswer, but two other producers of this same event type don't go through that —
					// screenOutputStream (output moderation, whenever OUTPUT_MODERATION is on) composes its FinalAnswer
					// from the raw token buffer it accumulated for screening, and emitInterruptedFinalAnswer
					// (Stop/abort) slices the raw streamed message.content. Both bypass generate.ts entirely,
					// so the leak must be caught again here at the single chokepoint all three paths share.
					const fenceCleaned = stripResponseTags(stripFenceTags(event.text));
					if (fenceCleaned !== event.text) event.text = fenceCleaned;
					// The token-cap notice, appended HERE and only here. The endpoint transform knows the
					// generation was cut (finish_reason "length") but cannot deliver text: generate.ts drops
					// the final chunk's token, and screenOutputStream rebuilds the body from Stream tokens
					// alone, so a notice written upstream reached the log and not the user (CUR-149). The
					// flag travels; the text is written at the one point all three producers pass through.
					event.text = withTruncationNotice(event.text, event.truncated);
				}
				const outgoing = await applyMessageUpdate(event, {
					message,
					initialMessageContent,
					model: activeModel,
					state,
					metrics: metricsCtx,
					saveTitle: async (sanitizedTitle) => {
						conversation.title = sanitizedTitle;
						// Through the write chain (invariant 3); awaited so a title-write failure still errors
						// the turn via the stream catch exactly as today (the chain's tail advances past it).
						await writeChain.enqueue(() =>
							collections.conversations.updateOne(
								{ _id: convId },
								{ $set: { title: conversation.title, updatedAt: new Date() } }
							)
						);
					},
				});
				// A code call waiting for a free sandbox is held the same way, inside the same room. (CUR-4584)
				genDeadline.setHumanWaiting(state.awaitingConfirmation || state.waitingForSandbox);

				if (outgoing === null) return;

				// Write the answer before the client is told it is final (CUR-2078). Without this the row
				// holds only the empty placeholder from the user-message write until the merged title stream
				// ends, which can be 10-16s after the answer when a side call is shed, so an export or reload taken
				// once Retry showed had no answer and no provenance. Bounded so a slow write delays the
				// answer by at most that much; the terminal persist still runs either way.
				if (outgoing.type === MessageUpdateType.FinalAnswer && !clientDetached) {
					await Promise.race([
						// The link logs its own write failure and never rejects; this catch keeps a loss of the
						// race from ever becoming an unhandled rejection if that changes.
						persistConversation().catch((err) =>
							logger.error(err, "[persist] FinalAnswer persist failed; the terminal persist retries")
						),
						new Promise<void>((resolve) => setTimeout(resolve, FINAL_ANSWER_PERSIST_WAIT_MS)),
					]);
				}

				if (!clientDetached) {
					try {
						controller.enqueue(JSON.stringify(outgoing) + "\n");
						if (outgoing.type === MessageUpdateType.FinalAnswer) {
							controller.enqueue(" ".repeat(4096));
						}
					} catch {
						clientDetached = true;
						logger.info(
							{ conversationId: convId.toString() },
							"Client detached during message streaming"
						);
					}
				}

				if (clientDetached) {
					await persistConversation();
				}
			}

			// Emit the streamed-so-far text as an interrupted final answer. The
			// stopping client freezes its UI at the Stop click and reports its
			// stop point on the abort marker, while tokens keep arriving here
			// until the marker is observed (longer still when the stop request
			// was delayed or retried). Clamp the text back to the stop point so
			// the message persists exactly as the user last saw it instead of
			// "growing back" on the next sync.
			const clampToStopPoint = async () => {
				const marker = await collections.abortedGenerations
					.findOne({ conversationId: convId })
					.catch(() => null);
				const clamped = clampStoppedContent({
					content: messageToWriteTo.content,
					initialLength: initialMessageContent.length,
					generationId,
					marker,
				});
				if (clamped === messageToWriteTo.content) return;
				messageToWriteTo.content = clamped;
				// The page renders a finished message from its stored FinalAnswer update, so a
				// FinalAnswer already recorded (output screening sends its own on abort) must carry the
				// clamped text too, or the reload shows everything screening had released. (CUR-2300)
				const text = clamped.slice(initialMessageContent.length);
				messageToWriteTo.updates = messageToWriteTo.updates?.map((u) =>
					u.type === MessageUpdateType.FinalAnswer ? { ...u, text } : u
				);
			};
			const emitInterruptedFinalAnswer = async () => {
				await clampToStopPoint();
				// An agent turn that stalls mid tool-use never wrote any streamed text, so the
				// slice below is "" and the user would see nothing despite real completed work (e.g. 3 of 4
				// files written before a post-confirm stall). agentConfirmations is the one durable per-call
				// record that survives that — see interruptedAgentSummary.ts. Only fills in when the slice
				// is genuinely empty; a turn that had already streamed real text keeps that text untouched.
				//
				// "Genuinely empty" is checked on more than the raw slice: an agent turn always opens
				// with a fixed <think> placeholder (endpointAgent.ts's "Working on it via the open agent…")
				// before any real answer starts — a stall before real text begins leaves that placeholder,
				// unclosed, as the entire slice. Raw truthiness would treat that as "real text, don't override
				// it", and the fallback would never run on exactly the case it exists for. stripThink
				// already treats an unclosed trailing <think> as dropped content (its own doc comment: "a
				// model that never escaped its think block is dropped, not shown as reasoning-masquerading-
				// as-an-answer") — same test, reused here to decide realness. The raw streamedText is still
				// what gets persisted when it IS real, so a normal turn's think-block provenance is untouched.
				const streamedText = messageToWriteTo.content.slice(initialMessageContent.length);
				const hasRealStreamedText = stripThink(streamedText).length > 0;
				// streamedText is NOT a valid fallback once hasRealStreamedText has already judged
				// it unreal (an unclosed <think> placeholder, stripThink's own reason to drop it) — falling
				// back to it anyway re-introduces the exact raw garbage this branch exists to avoid. The only
				// honest fallback below a missing summary is empty, matching what a genuinely silent turn
				// (no confirmations at all) has always correctly shown. (CUR-1178)
				const text = hasRealStreamedText
					? streamedText
					: (summarizeInterruptedAgentWork(messageToWriteTo.agentConfirmations) ?? "");
				await update({
					type: MessageUpdateType.FinalAnswer,
					text,
					interrupted: true,
				});
			};

			// The whole generation body — its own try/catch/finally included — is wrapped so it can be
			// RACED against a hard deadline below. The 45s watchdog above only calls ctrl.abort(), and
			// an upstream stream that never unwinds after that abort gives no terminal update, no persist,
			// no finalize, no close — the invocation survives to Vercel's 300s kill with the client spinning. The race is the backstop the abort can't be.
			const generationWork = async () => {
			try {
				// The chain's heartbeat ended at acceptance, but the overlapped settings read and question
				// save can still be pending. Keep proving liveness through those joins as well as screening
				// and retrieval, or an eight-second DB wait makes the client abort a healthy accepted turn.
				// The marker names what is running: our own documents (RAG), the web ("always" mode's early
				// retrieval), both, or neither (CUR-2223). Literal markers, not a computed name:
				// liveRequestLabels.spec reads them out of this file.
				const screeningMarker = webRetrievalPromise
					? documentsSearched
						? phaseMarker("screening-documents-web")
						: phaseMarker("screening-web")
					: documentsSearched
						? phaseMarker("screening-documents")
						: phaseMarker("screening");
				void update({
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.KeepAlive,
					message: screeningMarker,
				}).catch(() => {});
				// While a multi-chunk screen runs, the heartbeat carries which part it is on
				// (`phase:screening@4/9`), so a long paste's wait reads as progress, not as a stall. (CUR-3749)
				let shownPart = 0;
				retrievalHeartbeat = setInterval(() => {
					if (ctrl.signal.aborted) return;
					const part = !screenSettled && screenProgress.parts > 1 ? screenProgress.part : 0;
					const message = part > shownPart ? `${screeningMarker}@${part}/${screenProgress.parts}` : undefined;
					if (message) shownPart = part;
					void update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.KeepAlive,
						...(message ? { message } : {}),
					}).catch(() => {});
				}, 2000);

				if (message.attachmentNotice) {
					// The files the route marked on the sent message, so the open page marks them too. (CUR-3405)
					const questionId = message.ancestors?.at(-1);
					const leftOutFiles = conversation.messages.find((m) => m.id === questionId)?.leftOutFiles;
					await update({
						type: MessageUpdateType.AttachmentNotice,
						message: message.attachmentNotice.message,
						...(leftOutFiles?.length ? { leftOutFiles } : {}),
					});
				}
				if (message.agentRouteFailed) {
					await update({ type: MessageUpdateType.AgentRouteNotice });
				}

				// ── Pre-stream joins (§A step 8) ───────────────────────────────────────
				// Everything joined below was LAUNCHED post-claim in runPrestream (settings + the safety
				// gate + RAG + the always-web retrieval + the user-msg persist) and now OVERLAPS the stream
				// setup instead of serializing. The safety posture is unchanged: the answer is still gated by
				// moderation here before the model runs; on a decline the decline path drops the provenance
				// and the legs settle unused. Join in order.

				// FIRST join — user settings (invariant 6). Re-await the ORIGINAL prelaunched promise so a
				// real settings DB error still throws into THIS stream catch exactly as today (it is NOT
				// treated as absent settings — settings feeds multimodal/provider/reasoning/artifacts
				// overrides, not just billing). billingOrganization is assigned here, at the await, before any
				// consumer (endpointOai/searchDecision).
				const userSettings = await settingsPromise;
				// A visitor's own org counts only when their own token pays (CUR-3533).
				locals.billingOrganization = requestBillTo(userSettings?.billingOrganization, {
					useUserToken: config.USE_USER_TOKEN === "true",
					billTo: Reflect.get(config, "HF_BILL_TO") as string | undefined,
				});

				// SECOND join — the user-msg persist (invariant 5). On failure the stream emits Status=Error
				// (retryable) and stops BEFORE any generation — same core guarantee as today ("no answer on a
				// turn we couldn't store"); the stream catch sets hasError, so the tail's
				// finishGeneration('error') releases the claim exactly like the old awaited-persist release.
				// ACCEPTED DELTA (invariant 5b): the gate/RAG/web legs were already launched pre-stream, so on
				// a persist/settings failure here those calls (a Coop submit, embeds, engine queries) will
				// have fired for a turn that then errors — accepted (rare DB-blip classes; the fired calls
				// expose no new data class; refunding ~300–500ms of the win on every turn to protect a blip
				// path isn't worth it). The rejection propagates from the chain link itself (NOT swallowed by
				// the chain's tail-advance).
				await userMsgPersist;

				// The whole pre-stream stretch is now overlapped + NAMED — emit the [prestream] decomposition
				// once, at the join, so this span can never go dark again (§A4).
				logger.info(
					{
						conversationId: conversationKey,
						convLoadMs: turnSpans.convLoadMs,
						parseMs: turnSpans.parseMs,
						claimMs: turnSpans.claimMs,
						settingsMs: turnSpans.settingsMs,
						persistUserMsgMs: turnSpans.persistUserMsgMs,
						preStreamMs: turnSpans.preStreamMs,
					},
					"[prestream] timing"
				);

				// THIRD join — the safety gate. It settled (or settles) with the FULL verdict bundle + gateMs
				// already stamped and the [moderation] timing log already emitted at its OWN settlement (§A
				// step 6); consume it here WITHOUT re-running any check, so gateMs can neither lose the
				// child/content span nor absorb this join's idle time. A gate failure rethrows into this
				// stream catch exactly as today.
				const gate = await gatePromise;
				gateMs = gate.gateMs;
				// Only a declined turn reads its notice, so only a declined turn waits on detection; an
				// allowed turn never blocks on a cold detector load (CUR-4051).
				const declineLanguage =
					gate.childSafety.flagged || gate.contentPolicy.action === "block" ? await declineLanguagePromise : "en";

				// Decline precedence: child-safety (Coop, fail-closed) > content-policy block (Coop,
				// fail-open). No toxicity tier. Each stamps its own
				// honest `kind` so the SafetyBadge names the classifier that actually decided. Not-flagged
				// → allow (the model runs). (Prompt-injection has no tier here: the in-app classifier it
				// depended on is removed — see moderation.ts.)
				//
				// A pure function of the settled bundle.
				type GateBundle = Awaited<typeof gatePromise>;
				type ModerationDecision = {
					flagged: boolean;
					// CLIENT-FACING label — a SAFE value only (the kind), NEVER a raw Coop action code. The
					// raw action lives in `auditCategory` (server-only).
					label: string | null;
					score: number;
					kind: ModerationKind;
					declineText?: string;
					// Curated public-safe rule name, resolved server-side from the triggered Coop action.
					// Absent/unknown → the generic decline copy stands.
					ruleLabel?: string;
					// SERVER-ONLY raw Coop action (the rule identity) for the queryable T&S audit log. Never
					// placed on the message marker or the Safety update — the client only ever gets `ruleLabel`.
					auditCategory?: string;
					// The screen could not run (a fail-closed UNKNOWN): nothing was flagged (CUR-2301).
					unscreened?: boolean;
					// A self-harm rule declined the turn, so it carries crisis support (CUR-2111).
					support?: boolean;
				};
				const decideModeration = ({ childSafety, contentPolicy }: GateBundle): ModerationDecision =>
					childSafety.flagged
						? {
							flagged: true,
							label: "child_safety",
							score: 1,
							kind: "child_safety",
							// Per-rule decline copy from rules.json when this action has one; else the generic
							// child-safety decline stands (resolved below). A screen that could not run says so.
							declineText: childSafetyDeclineText(childSafety, resolveActionMessage(childSafety.category, declineLanguage)),
							...(childSafety.unscreened ? { unscreened: true } : {}),
							ruleLabel: resolveActionLabel(childSafety.category) ?? undefined,
							auditCategory: childSafety.category,
						}
					: contentPolicy.action === "block"
						? {
								flagged: true,
								label: "content_policy", // SAFE kind — not the raw action (that's auditCategory)
								score: 1,
								kind: "content_policy",
								// Per-rule decline copy from rules.json takes precedence; Coop supplies no message on
								// a block, so `contentPolicy.message` is the (usually empty) fallback before the generic.
								declineText: resolveActionMessage(contentPolicy.category, declineLanguage) ?? contentPolicy.message,
								ruleLabel: resolveActionLabel(contentPolicy.category) ?? undefined,
								auditCategory: contentPolicy.category,
								...(isSupportRule(contentPolicy.category) ? { support: true } : {}),
							}
						: // not flagged → allow; kind is unused when flagged is false.
							{ flagged: false, label: null, score: 0, kind: "content_policy" };

				const moderation = decideModeration(gate);

				// The DECLINE.
				const declineTurn = async (moderation: ModerationDecision) => {
					// A turn the S1 judge declined names it as the safety screen, so a decline says which
					// judge made it. Only an S1 screen records this; every other decline stores no helper, as before. (CUR-4527)
					if (gate.gateSource === "guard" && gate.served?.model === S1_JUDGE.model && assistedByEnabled()) {
						const screen = assistedByEntry("safety-screen", gate.served.model, gate.served.backend, gate.served.provider);
						if (screen)
							await update({ type: MessageUpdateType.RouterMetadata, route: "", model: "", assistedBy: [screen] }).catch(
								() => {}
							);
					}
					// Terminal outcome is `declined`, not `complete` (CUR-89) — see the declaration above.
					declineKind = moderation.kind;
					declinedAt = "input";
					messageToWriteTo.moderation = moderationMarker({
						label: moderation.label,
						score: moderation.score,
						kind: moderation.kind,
						ruleLabel: moderation.ruleLabel,
						unscreened: moderation.unscreened,
						support: moderation.support,
					});
					// Defense-in-depth honesty: a declined turn never reached the model, so any grounding
					// attached BEFORE the pre-screen was never used. Open-web search resolves client-side and
					// is stamped onto messageToWriteTo.webSearch above (RAG is attached only on the allow path
					// below, never here). Drop it so the PERSISTED message carries no phantom grounding —
					// provenanceFacts.grounded is then honest at the source on reload/shared views, not only
					// masked by the display-layer decline gates. (Otherwise a decline would show "searched the web · N
					// sources" and light the web-search node on a turn the model never ran.)
					delete messageToWriteTo.webSearch;
					delete messageToWriteTo.rag;
					// Queryable T&S log (/admin/safety) — declines otherwise live only in the conversation
					// JSONB. Best-effort + fire-and-forget so a log hiccup never fails the user's turn; stores
					// verdict metadata only, never the user's text.
					logDeclineSafe({
						kind: moderation.kind,
						// The operator audit sink records the RAW Coop action (the rule that fired) when there is
						// one — that's the diagnostic operators cross-check — falling back to the safe label
						// otherwise. This is server→DB only, never the client.
						label: moderation.auditCategory ?? moderation.label ?? undefined,
						score: moderation.score ?? undefined,
						conversationId: convId.toString(),
						messageId: messageToWriteTo.id,
						userId: userId ? String(userId) : undefined,
						sessionId: conv.sessionId ?? undefined,
					});
					await update({
						type: MessageUpdateType.Safety,
						kind: moderation.kind,
						label: moderation.label,
						score: moderation.score,
						...(moderation.ruleLabel ? { ruleLabel: moderation.ruleLabel } : {}),
						...(moderation.unscreened ? { unscreened: true } : {}),
						...(moderation.support ? { support: true } : {}),
					});
					// A declined turn's card reads in the language the person wrote in. The support
					// classifier names it, the same read an answered turn's card uses; it started with the screen,
					// so it has usually settled by now and its own timeout bounds the wait. The refusal's
					// n-gram detection is only the fallback: it reads short French and Italian as English.
					// Its "en" is also its no-answer value, so that leaves the card in the interface's language.
					// A rule other than the self-harm ones can decline a message in distress (CUR-4093), so the classifier's yes stamps
					// the card here as it does on an answered turn. Awaiting it on every decline costs the classifier's
					// remaining time, bounded by its own timeout. (CUR-4094)
					const signal = await supportSignalPromise.catch(() => null);
					if ((moderation.support || signal?.show) && messageToWriteTo.moderation) {
						const cardLang = signal?.lang || (declineLanguage !== "en" ? declineLanguage : undefined);
						const cardCountry = signal?.country || undefined;
						const newStamp = !moderation.support;
						messageToWriteTo.moderation.support = true;
						if (cardLang) messageToWriteTo.moderation.supportLang = cardLang;
						if (cardCountry) messageToWriteTo.moderation.supportCountry = cardCountry;
						if (newStamp || cardLang || cardCountry) {
							await update({
								type: MessageUpdateType.SupportNotice,
								...(cardLang ? { supportLang: cardLang } : {}),
								...(cardCountry ? { supportCountry: cardCountry } : {}),
							});
						}
					}
					// A per-rule message from rules.json (moderation.declineText) wins for ANY kind; otherwise the
					// generic, reviewed default for that kind stands.
					const declineText =
						moderation.declineText ??
						(moderation.kind === "child_safety" ? CHILD_SAFETY_DECLINE : CONTENT_POLICY_DECLINE);
					await update({
						type: MessageUpdateType.FinalAnswer,
						text: declineText,
						interrupted: false,
					});
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Finished,
					});
				};

				// NOT a moderation decline (nothing unsafe here, so declineKind/declinedAt are left
				// untouched — this is a completed turn from every other outcome-tracking consumer's point of
				// view, just answered from a pre-stored string instead of a generation call). Mirrors only the
				// two updates declineTurn ends on; RAG/generation are skipped entirely by never reaching the
				// `else` branch below, which is the actual point — this text is never model-touched. (CUR-742)
				const languageFallbackTurn = async (lang: string) => {
					delete messageToWriteTo.webSearch;
					delete messageToWriteTo.rag;
					// Say no model ran, so the receipt doesn't describe a generation that never happened. (CUR-1579)
					messageToWriteTo.fixedReply = { kind: "low-resource-language" };
					await update({ type: MessageUpdateType.FixedReply, kind: "low-resource-language" });
					await update({
						type: MessageUpdateType.FinalAnswer,
						// In the interface's language, which the layout reads from the same header. (CUR-1579)
						text: lowResourceFallbackMessage(lang, preferredLanguage(request.headers.get("accept-language"))),
						interrupted: false,
					});
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Finished,
					});
				};

				// The ALLOW-record, shared by the normal and language-fallback paths.
				const recordAllowed = async (
					{ verdict, contentPolicy, gateSource, hits }: GateBundle,
					moderation: ModerationDecision
				) => {
					// Record whether the pre-screen actually RAN and cleared, so the request-trace can tell
					// "screened, clear" from "let through unchecked". Derived from the SELECTED source's own
					// configured-check + verdict status (screenedForRecord) — the
					// old expression ANDed isCoopConfigured() unconditionally, which under guard-primary would
					// record a successfully guard-screened turn as unscreened. An UNKNOWN verdict (unreachable
					// / timeout) or no config for the selected source still means the turn was NOT verifiably
					// screened → false (the trace then honestly says "failed open / passed through", never
					// "screened, clear"). Safe on a non-flagged turn: every consumer keys on `.flagged` (false
					// here) or the declined step (which requires it).
					messageToWriteTo.moderation = {
						flagged: false,
						label: null,
						score: moderation.score ?? 0,
						kind: moderation.kind,
						screened: screenedForRecord(gateSource, verdict.status),
					};
					await update({ type: MessageUpdateType.InputScreen, screened: messageToWriteTo.moderation.screened });
					// A self-harm distress rule fired as a log hit (CUR-3915): the person gets the answer, led by
					// the Support resources card, whatever words tripped the rule. Persisted, so it shows on reload.
					// The rule's public label rides along, so X-ray names the rule that matched instead of listing it clear.
					const supportHit = hits?.find((h) => h.action === "log" && isSupportRule(h.key));
					if (supportHit) {
						const ruleLabel = resolveActionLabel(supportHit.key) ?? undefined;
						messageToWriteTo.moderation.support = true;
						if (ruleLabel) messageToWriteTo.moderation.ruleLabel = ruleLabel;
						await update({ type: MessageUpdateType.SupportNotice, ...(ruleLabel ? { ruleLabel } : {}) });
					}
					// The multilingual signal adds the card when the guard's English rules missed it, and
					// names the message's language for a card either of them stamped. It is not awaited here, so
					// the answer never waits on it; the turn's final persist awaits it. (CUR-4093)
					supportVerdict = stampSupportFromSignal(messageToWriteTo.moderation, supportSignalPromise, (extras) =>
						update({ type: MessageUpdateType.SupportNotice, ...extras })
					);
					// Non-blocking safety notice — the model was NOT declined, so it still runs and answers; this
					// just rides a chip alongside it. Fail-open (inert until Coop is wired).
					// Two sources feed the same `safetyNotice` chip: a Coop content-policy "redact" action,
					// or the generic checkAdvisory "notice" tier. The model still runs either way. Inert today.
					// Only the reviewed user-facing `message` ships — the raw Coop redact action (its `category`)
					// stays server-side, like the block path's auditCategory, so no raw code reaches the client.
					const notice =
						contentPolicy.action === "redact" && contentPolicy.message
							? { message: contentPolicy.message }
							: await checkAdvisory(userTextToScreen).then((a) =>
									a.notice && a.message ? { message: a.message } : null
								);
					if (notice) {
						messageToWriteTo.safetyNotice = { message: notice.message };
						await update({
							type: MessageUpdateType.SafetyNotice,
							message: notice.message,
						});
					}
				};

				if (moderation.flagged) {
					await declineTurn(moderation);
				} else if (languageFallback) {
					// The turn passed moderation like any other, so it's recorded the same way —
					// this just also never reaches RAG/generation below, on purpose. Checked AFTER moderation,
					// not before: a turn moderation would decline stays declined regardless of what language
					// it's in. (CUR-742)
					await recordAllowed(gate, moderation);
					await languageFallbackTurn(languageFallback);
				} else {
					await recordAllowed(gate, moderation);

					// Community-first retrieval — the RAG promise was STARTED ABOVE, concurrently with the safety
					// pre-screen (see the PARALLELISM block). Here we just await its result on the allow path;
					// community sources are numbered [1..k], the web AFTER them. Stamp + stream the provenance
					// before generation so the trace + map highlight appear during streaming.
					const ragContext = await ragPromise; // ragMs already recorded in the promise's .then above
					const ragStamp = ragProvenance(ragContext);
					if (ragStamp) {
						messageToWriteTo.rag = ragStamp;
						await update({
							type: MessageUpdateType.Rag,
							query: ragStamp.query,
							sources: ragStamp.sources,
							asOf: ragStamp.asOf,
							vaultSynthesis: ragStamp.vaultSynthesis,
						});
					}
					// Community count is the citation offset for the web sources ([k+1..]) — known now that RAG
					// resolved, and applied at the single numbering step below (numberWebSources). It counts the
					// visitor's own numbered sources too, which come before everything we retrieved (CUR-3844).
					const communityCount = visitorSourceCount + (ragStamp?.sources.length ?? 0);

					// The OPEN WEB — numbered AFTER the community sources ([k+1..]). By the user's webSearchMode:
					//   always — launched CONCURRENTLY above (webRetrievalPromise, §5.1); JOIN it here and number
					//            community-first. unservableLive already forced webAlways=false (skip).
					//   auto   — community-DEPENDENT: runs only when community is INSUFFICIENT (ragContext null)
					//            AND the per-turn margin gate says the turn needs current info. Decided HERE,
					//            after RAG, since it consumes ragContext.
					//   off    — never.
					let webSearchCtx: WebSearchOutcome | undefined;
					// Helper models that worked on this turn without writing it, sent as one
					// RouterMetadata frame once the planner has run (below), when provenance-assisted-by is on. (CUR-984)
					const assistedBy: AssistedBy[] = [];
					// The guard screen read the message before anything else did. Its entry comes from
					// the screen's own response, so a screen that reported no model leaves no entry. (CUR-3563)
					if (gate.gateSource === "guard" && gate.served) {
						const screen = assistedByEntry(
							"safety-screen",
							gate.served.model,
							gate.served.backend,
							gate.served.provider
						);
						if (screen) assistedBy.push(screen);
					}
					// GROUNDING GATE (set after the search below): true only when the reranker VERIFIED
					// relevance AND there is ≥1 source. Both the webSearch stamp and the evidence injection
					// are gated on it, so the guard-time and prompt-time grounded predicates can't disagree.
					let groundedWeb = false;
					// Was the web path engaged at all (was `webPlan !== "skip"`)? Gates the searchAttempt stamp.
					let webEngaged = false;
					// Set when the leg ran and failed (deadline or error), so the answer says the
					// search didn't finish rather than reading as one nobody ran. (CUR-4091)
					let webFailed: WebSearchFailure | undefined;
					const onWebFailed = (why: WebSearchFailure) => (webFailed = why);
					// Effective plan for the [retrieval] log below (always ⇒ launched early ⇒ "run").
					let webPlan: "skip" | "run" | "auto-gate" = "skip";
					let nativeSearchGate: Promise<boolean> | undefined;
					// A link the person pasted is read directly rather than searched for (CUR-1897). The whole
					// sentence would otherwise go to search as a query, and even when the exact article came back its
					// 500-char snippet was all the model saw. Started here so it overlaps the search decision;
					// joined below, before the grounding gate. Not on an agent turn (that endpoint never reads
					// these sources), and not with web search OFF, whose control promises training and community
					// sources only. Post-gate: moderation has already cleared this message.
					// A tool-retrieving (native) turn reads the link itself (CUR-2697), its forced first `read_page`
					// call (nativeTools.ts), so reading it here too would fetch every pasted link twice and hold
					// generation for the copy nobody used.
					const pastedUrl = !isAgentTurn ? extractLinkedUrl(userTextToRag ?? "") : undefined;
					const linkedUrl = webSearchMode !== "off" && harness.retrieval === "pipeline" ? pastedUrl : undefined;
					const linkedPagePromise = linkedUrl
						? fetchLinkedPage(linkedUrl, { skipFirecrawl: faultInjection === "linked_page_firecrawl_down" })
						: undefined;
					let linkedPageRead = false;
					// What the model is told about the link (see linkedPageNote; CUR-2032). A pasted link with
					// search off is still named, so the answer says why it wasn't opened instead of claiming
					// links can never be opened.
					let linkedPage: LinkedPageState | undefined =
						pastedUrl && webSearchMode === "off" ? { kind: "search-off" } : undefined;
					// The agent endpoint never reads searchContext (see the isAgentTurn declaration
					// near the top of this handler) — webAlways is already false for an agent turn (gated at
					// its own declaration), but the auto/off path below independently re-derives webPlan from
					// scratch, so it needs its own guard here rather than inheriting webAlways's. (CUR-574)
					// Where the web leg's time goes. Each stage is measured where it is awaited and
					// lands on the `[retrieval] timing` line below as `webMs`; `preWebMs` is everything from
					// the legs-start clock to here, so the parts sum to totalRetrievalMs. (CUR-2105)
					const webLegStart = Date.now();
					const webMs: Record<string, unknown> = {};
					const timed = async <T>(key: string, p: Promise<T>): Promise<T> => {
						const t = Date.now();
						try {
							return await p;
						} finally {
							webMs[key] = Date.now() - t;
						}
					};
					if (isAgentTurn || harness.retrieval === "tools") {
						// A native turn searches through its own tool calls, stamped as they return.
						// webEngaged stays false, webSearchCtx stays undefined — the whole `if (webEngaged)`
						// stamping block below is skipped entirely, same as an ordinary turn with search off. (CUR-2420)
						// On Auto the gate is still asked, and its "search" forces the first round to
						// web_search (native.ts). A question our local catalog covers, and that wants nothing recent,
						// is not forced to the web, since the turn reads the catalog itself through search_catalog;
						// a live ask no source here carries keeps web_search withheld. (CUR-4083)
						if (
							!isAgentTurn &&
							webSearchMode === "auto" &&
							!unservableLive &&
							userTextToRag &&
							searchIntentEnabled()
						) {
							const q = userTextToRag;
							nativeSearchGate = nativeGateSaysSearch(
								q,
								readSelfIdentityVerdict,
								undefined,
								() =>
									ragWillSearch(q) && localStoreReady()
										? queryLocalStore(q).then((hits) => hits.length)
										: Promise.resolve(0),
								recencyHint
							);
						}
					} else if (webAlways) {
						webEngaged = true;
						webPlan = "run";
						// Either JOIN the concurrent (no-history) retrieval, or — for a history turn whose rewrite is
						// a model call that had to wait for moderation — retrieve now, post-gate. Both number
						// community-first via numberWebSources (the single numbering authority, so the sources' [n]
						// and the evidence block's [n] can't disagree).
						let retrieval: WebRetrieval | undefined;
						if (webRetrievalPromise) {
							// Only the wait left at the join: the retrieval started concurrently with RAG, so
							// its own stage timings (below) can exceed this.
							retrieval = await timed("joinMs", webRetrievalPromise);
							webFailed = webRetrievalFailure.why;
						} else {
							// Live phase: the post-gate always search (coreference rewrite + engines) is about to run.
							void update({
								type: MessageUpdateType.Status,
								status: MessageUpdateStatus.KeepAlive,
								message: phaseMarker("searching"),
							}).catch(() => {});
							retrieval = await timed(
								"searchMs",
								runWebRetrieval(userTextToRag, {
									locals,
									history: searchHistory,
									ctx: searchCtx,
									hang: faultInjection === "web_search_hangs",
									onFailed: onWebFailed,
								})
							);
						}
						if (retrieval?.timings) Object.assign(webMs, retrieval.timings);
						if (retrieval?.rewriteAssist) assistedBy.push(retrieval.rewriteAssist);
						if (retrieval) {
							const { sources, evidence } = numberWebSources(
								retrieval.merged,
								communityCount,
								retrieval.credibility
							);
							webSearchCtx = {
								query: retrieval.query,
								sources,
								evidence,
								asOf: retrieval.asOf,
								relevanceVerified: retrieval.relevanceVerified,
							};
						}
					} else if (userTextToRag) {
						// auto/off: recompute the community-DEPENDENT plan now that ragContext is known.
						webPlan = webSearchPlan({
							mode: webSearchMode,
							communitySufficient: !!ragContext,
							// A recency query ("latest developments", a year) must reach the gate even when the
							// catalog had hits — the static catalog can't hold current info, so the web augments it.
							recencyHint,
							unservableLive,
						});
						if (webPlan === "auto-gate") {
							webEngaged = true;
							// auto + community didn't cover it → ask the margin gate whether the turn needs the web.
							// Pass the stored recency so the decision reuses the single source of truth (MINOR-2);
							// preShaped rides through so a model-authored tool query flows into the engines verbatim.
							// `model` here is post-swap (:263) — pass it so the classifier asks the model that
							// will actually answer; otherwise a swapped turn has its content and its search
							// decision made by two different models on two different hosts.
							// A question about Alpha itself is answered from its own provenance, never the web
							// (CUR-2135). The gate's exemplars are English, so a French question such as "Quel modèle es-tu, et qui le fait
							// tourner ?" would search and get answered about an unrelated campaign of that name. The
							// multilingual identity verdict catches the same question, so it vetoes here.
							// Read in parallel with the gate, so a warm embedder (~150 ms) adds nothing to the decision;
							// a cold one gets 1.5 s, not the verdict's 6 s budget, before the gate decides alone.
							const [{ search, query, preShaped, assist }, identityRead] = await Promise.all([
								timed(
									"decideMs",
									decideWebSearch(
										userTextToRag,
										locals,
										recencyHint,
										model,
										turnAttachmentKinds,
										// A model that reads images decides from the photo itself and writes
										// the query from what it sees. The media pass and its gate settled before
										// retrieval joined, so this await costs nothing and sends no unscreened photo. (CUR-3192)
										model.multimodal && model.supportsTools
											? deciderImages(await preparedMediaPromise.catch(() => undefined))
											: []
									)
								),
								readIdentityWithin(readSelfIdentityVerdict, 1_500, "self-identity"),
							]);
							const identity = identityRead.verdict;
							if (assist) assistedBy.push(assist);
							if (search && identity?.isSelf) {
								logger.info(
									{ leg: "self-identity", margin: identity.margin },
									"[search] gate said search; a question about Alpha itself, so not searching"
								);
							}
							if (search && !identity?.isSelf) {
								logger.info(
									// not-run is the flag off or no text to read; stampFlagOn says which.
									{ leg: "self-identity", ...identityRead.reading, stampFlagOn: providerStampEnabled() },
									"[search] gate said search; searching"
								);
								// Live phase, sent only once the gate has said search. Sent before the decision,
								// every turn the gate declined would still show "Searching the open web…" (CUR-2038).
								void update({
									type: MessageUpdateType.Status,
									status: MessageUpdateStatus.KeepAlive,
									message: phaseMarker("searching"),
								}).catch(() => {});
								webSearchCtx = await timed(
									"searchMs",
									runWebSearch(query, {
										locals,
										startAt: communityCount,
										history: searchHistory,
										ctx: searchCtx,
										preShaped,
										hang: faultInjection === "web_search_hangs",
										onFailed: onWebFailed,
									})
								);
								if (webSearchCtx?.timings) Object.assign(webMs, webSearchCtx.timings);
								if (webSearchCtx?.rewriteAssist) assistedBy.push(webSearchCtx.rewriteAssist);
							}
						}
					}
					if (linkedPagePromise) {
						const page = await timed("linkedPageWaitMs", linkedPagePromise);
						if (page) {
							// The page the person chose is relevant by construction, so it grounds the turn, and
							// alone (CUR-2032): search hits behind it can contradict it. For a user's link they could be an older
							// survey from the same institute, and the answer could summarise the page with that survey's
							// sample size instead of the page's own, citing
							// the page. A person who links a page is asking about that page.
							linkedPageRead = true;
							webEngaged = true;
							const { sources, evidence } = numberWebSources([page], communityCount);
							linkedPage = { kind: "read", n: sources[0].n };
							webSearchCtx = {
								query: webSearchCtx?.query ?? page.url,
								sources,
								evidence,
								asOf: webSearchCtx?.asOf ?? new Date().toISOString(),
								relevanceVerified: true,
							};
						} else {
							linkedPage = { kind: "unreadable" };
						}
					}
					const stampStart = Date.now();
					if (webEngaged) {
						// GROUNDING GATE: stamp web provenance (and inject evidence below) ONLY when the reranker
						// VERIFIED relevance AND there is ≥1 source. An unverified-but-nonempty result — a cold or
						// failed reranker, or a live-stale page that slipped the floor — is DROPPED for grounding:
						// no webSearch stamp, no evidence, no [n] citations, so the turn answers ungrounded rather
						// than fabricating a grounded look. relevanceVerified is the server-local carrier off
						// WebSearchOutcome (never a wire type). See docs/plan-websearch-grounding-fix.md.
						groundedWeb = !!(webSearchCtx?.relevanceVerified && webSearchCtx.sources.length > 0);
						const webStamp = groundedWeb ? searchProvenance(webSearchCtx) : undefined;
						if (webStamp) {
							messageToWriteTo.webSearch = webStamp;
							await update({
								type: MessageUpdateType.WebSearch,
								query: webStamp.query,
								sources: webStamp.sources,
								asOf: webStamp.asOf,
							});
						} else {
							// The search path was engaged but the turn never grounded — either the margin gate
							// declined to query the engines (webSearchCtx still undefined) or a round-trip ran and
							// found nothing verified. Record the honest attempt either way so the trace doesn't
							// silently read as "no search considered at all".
							const searchAttempt = searchAttemptNotice(true, !!webSearchCtx, webStamp, webFailed);
							if (searchAttempt) {
								messageToWriteTo.searchAttempt = searchAttempt;
								await update({
									type: MessageUpdateType.SearchAttempt,
									grounded: false,
									searched: searchAttempt.searched,
									...(searchAttempt.failed ? { failed: searchAttempt.failed } : {}),
								});
							}
						}
					}

					// Retrieval done — log the phase latency so the silent gap (compared against the client's
					// 8s first-token watchdog) is observable in prod. A totalRetrievalMs near/over ~8000 is the
					// dropped-query signal.
					//
					// The heartbeat does NOT stop here (CUR-1156, CUR-1667). It runs to the end of the turn,
					// because textGeneration's own keepalive merge covers only ~2s of a
					// generation window that can run past 20, and a silent window past the client's 8s
					// watchdog aborts a turn that goes on to complete server-side.
					totalRetrievalMs = Date.now() - retrievalStart;
					generationUpdatesFrom = messageToWriteTo.updates?.length ?? 0;
					webMs.stampMs = Date.now() - stampStart;
					logger.info(
						{
							conversationId: conversationKey,
							ragMs,
							totalRetrievalMs,
							preWebMs: webLegStart - retrievalStart,
							webLegMs: Date.now() - webLegStart,
							webMs,
							webPlan,
							// The mode the request carried, so a turn's search setting is readable here. (CUR-4274)
							webSearchMode,
							searched: !!webSearchCtx,
							sources: webSearchCtx?.sources.length ?? 0,
							// Distinguishes "searched + grounded" from "searched but DROPPED as unverified" (the
							// L3 gate) — the signal for a cold/failed reranker in prod.
							groundedWeb,
							unservableLive,
							// A link was in the message (linkedLink) and its page was read (linkedPageRead). (CUR-1897)
							linkedLink: !!linkedUrl,
							linkedPageRead,
						},
						"[retrieval] timing"
					);
					// The heartbeat is NOT cleared here. textGeneration's own 100ms KeepAlive merge covers
					// only about two seconds before the wire goes silent until the answer (timed per frame
					// with Chrome DevTools `Network.dataReceived`), and the client's FIRST_TOKEN_TIMEOUT_MS
					// is 8000. A silence past that is the difference between a turn the user sees and one
					// the client aborts while the server goes on to finish and persist it (CUR-1667).
					//
					// So the heartbeat runs to the end of the turn. It is cleared in the `finally` below
					// and in the zombie path, both unconditionally, and its own callback no-ops once
					// `ctrl.signal` aborts. A KeepAlive costs 39 bytes, is filtered client-side before
					// `updates[]`, and is excluded from the persisted audit log, so overlapping the
					// KeepAlive merge for its two live seconds costs one extra frame per two seconds and
					// nothing else. The merge stops early for a reason not yet established (CUR-1667); this does not
					// depend on the answer.
					// Math routing (mathRouting.ts): the turn planner, one forced plan_turn call on
					// ARITHMETIC_ROUTE_MODEL, decides on every turn whether the latest message asks for a number
					// to be worked out, and records the setup that code sums (CUR-2198).
					// Polled first: on a cold instance an unpolled snapshot reads every flag off.
					await ensureFlagsPolled();
					const mathRouting = harness.mathRouting && mathRoutingEnabled();
					const planModelId = ((Reflect.get(config, "ARITHMETIC_ROUTE_MODEL") as string | undefined) ?? "").trim();
					// The planner reads text only; a turn about an attachment is the answer model's (CUR-3011).
					const plansThisTurn = mathRouting && plansTurnFor(model) && plannerSeesTurn(messagesForPrompt);
					if (mathRouting && plansTurnFor(model) && !plansThisTurn)
						logger.info("[turn-plan] newest message carries a file the planner cannot read; no turn is planned");
					const planModel = plansThisTurn && planModelId ? models.find((m) => m.id === planModelId) : undefined;
					if (plansThisTurn && !planModel)
						logger.warn({ planModelId }, "[turn-plan] plan model is not registered; no turn is planned");
					let mathLedger: Ledger | null = null;
					let calculateFirst = false;
					let followUpStandalone: string | null = null;
					// GLM reads the visitor's text only once the input screen has allowed it (CUR-2125), which
					// this branch already guarantees: the gate was awaited above and a decline never gets here.
					if (planModel) {
						const latestUserText =
							[...messagesForPrompt].reverse().find((m) => m.from === "user")?.content ?? "";
						const planRun = await planTurn(
							messagesForPrompt,
							planModel,
							AbortSignal.any([ctrl.signal, AbortSignal.timeout(PLAN_TIMEOUT_MS)])
						);
						mathLedger = planRun.plan?.math.ledger ?? null;
						// A tool-calling model keeps its own turn; the plan only makes its answer call
						// calculate first, and the tool's own result is what the reader sees. (CUR-4191)
						if (mathLedger && plannedMathForcesCalculate(model)) {
							calculateFirst = true;
							mathLedger = null;
						}
						// The rendered rows carry no marker, so the next turn's planner finds them here (CUR-3663).
						if (mathLedger) messageToWriteTo.mathLedger = mathLedger;
						// A plan call that answered is a helper on this turn whether or not it found math; one
						// that failed or timed out contributed nothing, so it is not named.
						if (planRun.outcome !== "failed" && planRun.outcome !== "timeout") {
							const entry = assistedByEntry(
								"math-route",
								planModel.id,
								(planModel.endpoints?.[0] as { baseURL?: string } | undefined)?.baseURL,
								planRun.provider
							);
							if (entry) assistedBy.push(entry);
						}
						followUpStandalone = planRun.followUp.standalone;
						// Also on the rung below, but `ttft-baseline` reads timings, not rungs (CUR-2137).
						turnSpans.turnPlanMs = planRun.ms;
						// `gate` is the planner's own verdict on the math field; `outcome` is that field's
						// outcome when the call answered, and the call's exit when it did not.
						const math = planRun.plan?.math.outcome;
						turnRungs.push({
							rung: "math-route",
							gate: math === "ok" || math === "invalid" ? "yes" : math === "not-asked" || math === "nothing-to-compute" ? "no" : "failed",
							outcome: math ?? planRun.outcome,
							gateMs: 0,
							toolMs: planRun.ms,
							numberCount: countNumbers(latestUserText),
						});
						// On the message now, not only in the terminal persist: the FinalAnswer persist
						// (CUR-2078) writes the row before the client hears the answer is final, and a reader of
						// that row found the answer with no rung (CUR-2161's scenario).
						messageToWriteTo.rungs = turnRungs;
					}
					// Without a ledger (not asked, or the call failed, timed out or returned nothing usable) the
					// turn is answered in prose with no code-summed total, and stripForgedStamp below removes any
					// "checked by code" label the model copies from older answers in history (CUR-2199, CUR-3663).
					// With a ledger, the plan model writes the words under it too. A model that writes the
					// words under a checked total can restate a different one (13 or 9.5 under a checked 10);
					// the planner model did so far less often (CUR-2198). The planner, not either model's own tool call, decides.
					if (assistedBy.length && assistedByEnabled()) {
						void update({
							type: MessageUpdateType.RouterMetadata,
							route: "",
							model: "",
							assistedBy,
						}).catch(() => {});
					}
					const turnModel = mathLedger && planModel ? planModel : model;
					const ctx: TextGenerationContext = {
						model: turnModel,
						// The watchdog's own end, so a retry inside the answer can tell whether it still fits.
						turnDeadlineAt: genWatchdogArmedAt + genTimeoutMs,
						harness,
						webSearchMode,
						// A model Auto chose gives up sooner when silent, so the browser can ask Auto
						// again inside the visitor's wait. A hand pick keeps its own give-up, or the watchdog. (CUR-4384)
						endpoint: await turnModel.getEndpoint(
							autoRouted && turnModel === model && autoRepickEnabled()
								? { giveUpMs: autoRepickGiveUpFor(turnModel.id) }
								: undefined
						),
						mathLedgerNote: mathLedger ? ledgerAnswerNote(mathLedger) : undefined,
						calculateFirst,
						followUpNote: followUpStandalone ? followUpNote(followUpStandalone) : undefined,
						conv,
						supportVerdict,
						messages: withLowResourceNoticeSummarized(messagesForPrompt),
						promptedAt,
						ip: getClientAddress(),
						username: locals.user?.username,
						browserLanguage: preferredLanguage(request.headers.get("accept-language")) ?? undefined,
						// Force-enable multimodal if user settings say so for this model — now ANDed with the
						// deployment gate, which this path did not consult (CUR-159). The override cannot
						// reach the model right now (parseRequest rejects every attachment while the gate is
						// shut, so no conversation can acquire a file to format), but
						// `prepareMessagesWithFiles` reads files off the message HISTORY — so the first time
						// multimodal goes on and then off again, this would keep sending images from the
						// conversations that already have them. That cycle is what the gate exists to survive.
						forceMultimodal: resolveForceMultimodal({
							isHuggingChat: config.isHuggingChat,
							override: userSettings?.multimodalOverrides?.[model.id],
						}),
						// Thinking-effort override — ANDed with the model's own capability, the same way
						// resolveForceMultimodal ANDs a stored multimodal override with the deployment gate
						// (CUR-700): a stale reasoningOverrides entry from a model that once supported
						// reasoning must never reach one that doesn't.
						// A routed math turn asks for no chain of thought (CUR-2065): a reasoning model given a token budget
						// can spend it thinking and stop at the length limit; "none"
						// is the setting second-opinion already relies on for the same lane (CUR-149).
						reasoningEffort:
							turnModel !== model
								? "none"
								: resolveReasoningEffort({
										supportsReasoning: model.supportsReasoning,
										override: userSettings?.reasoningOverrides?.[model.id],
										effort: userSettings?.reasoningEffortOverrides?.[model.id],
									}),
						// Artifacts aren't provider-determined, so the per-model user
						// override applies on HuggingChat too
						artifactsOverride: userSettings?.artifactsOverrides?.[model.id],
						// Open-web grounding for this turn (evidence + date only; the model cites the numbered
						// sources). Persistence of the sources happens on messageToWriteTo.webSearch above. Fed
						// to the model ONLY when groundedWeb — the SAME gate as the webSearch stamp — so the
						// prompt-time grounded predicate (textGeneration/index.ts) and the guard-time one
						// (message.webSearch) can never disagree. Computed server-side after RAG (webSearchCtx).
						searchContext:
							groundedWeb && webSearchCtx
								? { evidence: webSearchCtx.evidence, asOf: webSearchCtx.asOf }
								: undefined,
						// L2: honest capability note for a structurally-live ask the open engines can't serve —
						// the persona swaps its "offer to search" recency line for "I don't have live X".
						unservableLive,
						nativeSearchGate,
						linkedPage,
						visitorSourceCount,
						ragContext,
						speakAll,
						speakMode,
						// Source-aware screening posture from the carried per-turn policy — the persona states
						// the SELECTED gate's config, not Coop's.
						screeningFacts: turnPolicy.screeningFacts,
						// The settled shared media pass — preprocessMessages reuses it (finalText + hydrated
						// image sources) instead of hydrating a second time. Already resolved here: the gate
						// (chained off the same promise) was awaited before generation, so this is free.
						preparedMedia: await preparedMediaPromise,
						locals,
						abortController: ctrl,
						timings: turnSpans,
						onModelOutput: () => {
							state.lastModelOutputAt = new Date();
						},
						faultInjection,
						...(agentAttach && messageToWriteTo.agentRun
							? {
									agentAttach: {
										taskId: messageToWriteTo.agentRun.taskId,
										machineId: messageToWriteTo.agentRun.machineId,
									},
								}
							: {}),
						// The request's own origin, not PUBLIC_ORIGIN: on preview that names develop, and a PR
						// preview adding the clip would point the player at a deployment that lacks it.
						...(faultInjection === "tts_canned_clip" ||
						faultInjection === "tts_slow_canned_clip" ||
						faultInjection === "tts_canned_clip_output_blocked"
							? { ttsCannedClipUrl: new URL(CANNED_READ_ALOUD_CLIP, request.url).href }
							: {}),
						// The same clip, eight seconds late, so the reply's text has time to show first. (CUR-3810)
						...(faultInjection === "tts_slow_canned_clip" ? { ttsCannedClipDelayMs: 20_000 } : {}),
					};
					// Honesty screening (dangling citations, label faithfulness, fabricated URLs, hedge
					// stripping, orthography, unbacked source claims) wraps EVERY turn's stream uniformly,
					// regardless of OUTPUT_MODERATION — see honestyStream.ts's module header. Only the raw
					// source differs by that toggle; whether honesty-flash is fixed must not.
					const groundedTurn = !!(message.webSearch || message.rag);
					const honestySources = [
						...(message.rag?.sources ?? []),
						...(message.webSearch?.sources ?? []),
					].map((s) => ({ n: s.n, title: s.title, url: s.url }));
					const honestyAllowedUrls = [
						...(message.rag?.sources.flatMap((s) => (s.url ? [s.url] : [])) ?? []),
						...(message.webSearch?.sources.map((s) => s.url) ?? []),
					];
					// The generation_timeout fault holds the turn HERE, after the watchdog is armed
					// and before screenOutputStream exists. Inside the generator, output screening's own 25s
					// phase deadline would end the turn first as a capacity decline, so the spec would never
					// reach the watchdog's "took too long" path, which is the one prd (screening off) serves. (CUR-1921)
					if (faultInjection === "generation_timeout" && !ctrl.signal.aborted)
						await new Promise<void>((resolve) =>
							ctrl.signal.addEventListener("abort", () => resolve(), { once: true })
						);
					// The ledger rows go on the raw generation so they pass through everything the answer does:
					// output screening and honesty (CUR-2125). GLM writes their labels.
					// With math routing on, every turn's model text loses any stamp it copied, and only then does
					// a real ledger go in front of it.
					const turnText = turnModel !== model ? namedServedModel(textGeneration(ctx), turnModel.id) : textGeneration(ctx);
					// A base guard on every turn, whatever the harness or the flag. History can hold a
					// stamp an earlier math-routing turn rendered, and a model copies it onto a total code never
					// summed. (CUR-2697)
					const answer = stripForgedStamp(turnText);
					const generated = mathLedger ? ledgerPrefixStream(answer, mathLedger) : answer;
					// A loop is cut here, before the output screen reads it: a screen that reads thousands of
					// repeated words can decline a harmless answer as violent (CUR-3318).
					// An agent turn's <think> block is its step trace, which restates itself between steps; only
					// the answer after it is read for loops (CUR-4105).
					const baseSource = cutRepetitionLoop(generated, declineLanguagePromise, {
						skipReasoning: model.id === AGENT_MODEL_ID,
					});
					// Output enablement comes from the CARRIED turn policy, never a live re-read.
					// Under guard-primary the answer is screened by the SAME detector as the input
					// gate; flag-OFF keeps the Coop-shaped screen. Whether it runs at all is the OUTPUT_MODERATION
					// env var (outputModerationRequested/outputModerationEnabled in moderation.ts), so read the
					// value per environment there, not from a comment.
					// The person's question plus any file it attached, so an answer quoting their own rota is not
					// read as exposing strangers (CUR-1837). The media pass settled before generation started.
					const askerText = outputAskerText(messagesForPrompt, await preparedMediaPromise.catch(() => undefined));
					// S1 screens the answer too while s1-safety-judge is on (OUTPUT_MODERATION decides
					// whether this screen runs at all). A fault-injection turn keeps today's judge. (CUR-4527)
					const outputS1 = screenStub || faultInjection ? undefined : s1JudgeFor(logger);
					const guardOutputScreen = (text: string, userId?: string) =>
						screenOutputWithGuard(text, userId, { askerText, ...(outputS1 ? { s1: outputS1 } : {}) });
					// A flagged batch is asked again, with the question and the whole answer so far,
					// before the answer is cut. The output_screen_recheck_clears fault flags every batch and
					// answers the re-check with a stub "no", so a spec sees a flagged batch released whole. (CUR-3975)
					const recheckFault = faultInjection === "output_screen_recheck_clears";
					const outputRecheck: OutputRecheck = (prior, batch, first, budgetMs) =>
						(recheckFault ? recheckFaultRecheck : recheckOutputBlock)(prior, batch, first, {
							askerText,
							timeoutMs: budgetMs,
						});
					const rawSource = turnPolicy.outputModerationEnabled
						? // OUTPUT screening (defense-in-depth): screen the model's answer SENTENCE BY SENTENCE
							// and release each chunk only after it clears (hold-and-release), so the answer still
							// streams while no unscreened byte ever reaches the client. screenOutputStream owns
							// the chunking, the per-chunk Coop screen, and the cleared-chunk Stream emits. It
							// stamps the output verdict via onModeration so the request-trace's "Output screen"
							// step stays honest.
							screenOutputStream(baseSource, {
								// Source-selected screen: the guard detector under
								// guard-primary, else the Coop-shaped default.
								// The person's own message rides along for the privacy rule, so details they typed
								// themselves aren't withheld as someone's private information (CUR-1837).
								// The output_screen_blocks fault blocks every chunk, so a spec reaches the
								// decline a visitor reads when the screen withholds a composed answer. (CUR-2810)
								screen:
									faultInjection === "output_screen_blocks" ||
									faultInjection === "tts_canned_clip_output_blocked"
										? async () => ({ blocked: true, kind: "content_policy" as const })
										: // CUR-4051: blocks every chunk on the drugs rule, so a spec reads that rule's notice.
											faultInjection === "output_screen_blocks_rule"
										? async () => ({ blocked: true, kind: "content_policy" as const, category: "chat-block-drugs" })
										: recheckFault
										? async () => recheckFaultFlag()
										: // CUR-3891: the real guard screen with a guard that never answers, so a spec
											// reads what a visitor sees when the output check cannot finish.
											faultInjection === "output_guard_unreachable"
											? (text: string, userId?: string) =>
													screenOutputWithGuard(text, userId, {
														askerText,
														judge: async () => ({ answer: { kind: "unknown" }, httpOk: false }),
													})
											: screenStub
											? stubOutputScreen
											: turnPolicy.useGuardPrimary
											? guardOutputScreen
											: undefined,
								userId: coopUserId,
								timings: turnSpans,
								signal: ctrl.signal,
								declineLanguage: declineLanguagePromise,
								// The route owns the ledger: every screen records here and the finalizer
								// drains it for the ONE output report and flips stopped as the terminal boundary.
								ledger: outputLedger,
								// The output_screen_timeout fault trips the no-token decline in a second while
								// textGeneration holds without calling a model. The only pre-token bound (CUR-2243). (CUR-1872)
								...(faultInjection === "output_screen_timeout" ? { preTokenDeadlineMs: 1_000 } : {}),
								// A real answer under a short idle window, so a turn that streams for longer
								// than that proves the window re-arms on each release rather than capping the answer. (CUR-1884)
								...(faultInjection === "output_screen_window_short"
									? { phaseDeadlineMs: outputScreenWindowFaultMs() }
									: {}),
								// An agent turn works silently past the 25s window, pulsing keepalives. (CUR-546)
								...(isAgentTurn ? { rearmOnProgress: true } : {}),
								recheck: outputRecheck,
								onModeration: (marker) => {
									message.outputModeration = marker;
								},
							})
						: baseSource;

					// A regen REPLACES the whole answer and would otherwise never pass
					// the output screen. Screen it with the same ScreenFn on the SAME ledger, with the terminal
					// boundary re-checked after the generation await and after the screen await. On a
					// block/UNKNOWN the regen is rejected (honestyStream falls back) and the marker is overwritten
					// so the persisted record describes the screen that actually refused. Shared by the
					// grounded-bail regen (CUR-148) and the recital regen (CUR-3886).
					const screenedRegen = async (regenText: string | undefined): Promise<string | undefined> => {
					if (outputLedger?.stopped) return undefined;
					// The regen generates outside stripForgedStamp and ledgerPrefixStream, so a
					// web-grounded maths turn that bailed shipped the model's own copied stamp (CUR-2198).
					const regen =
						regenText !== undefined
							? settleReplacedAnswer(regenText, mathLedger)
							: regenText;
					if (!turnPolicy.outputModerationEnabled || regen === undefined) return regen;
					const screenFn = screenStub
						? stubOutputScreen
						: turnPolicy.useGuardPrimary
							? guardOutputScreen
							: screenModelOutput;
					const promise = screenFn(regen, coopUserId);
					// On the SAME ledger, so a delayed regen result is drained by finalizeOutput like
					// any other batch and its hits (on EVERY status) reach the one output report.
					outputLedger?.dispatched.push({ promise, text: regen, released: false });
					const res = await promise;
					if (outputLedger?.stopped) return undefined;
					if (res.blocked) {
						// block OR fail-closed UNKNOWN (screenOutputWithGuard maps UNKNOWN → blocked
						// child). Overwrite the marker as flagged (never the raw rule key) so the
						// persisted record + the OutputSafety update describe the refusal, not the
						// original answer that "cleared".
						const kind = res.kind === "child_safety" ? "child_safety" : "content_policy";
						const ruleLabel = resolveActionLabel(res.category) ?? undefined;
						message.outputModeration = {
							flagged: true,
							label: kind,
							score: 1,
							kind,
							screened: true,
							...(ruleLabel ? { ruleLabel } : {}),
						};
						return undefined;
					}
					return regen;
					};

					// run the text generation and send updates to the client.
					const honestySource = !harness.streamGuards
						? rawSource
						: honestyScreenStream(rawSource, {
						grounded: groundedTurn,
						noticeLanguage: declineLanguagePromise,
						messageLanguage: messageLanguagePromise,
						sources: honestySources,
						visitorSourceCount,
						allowedUrls: honestyAllowedUrls,
						// A tool-retrieving turn finds its sources mid-stream (CUR-2697).
						sourcesFromStream: harness.retrieval === "tools",
						// A support-stamped turn is a crisis answer from its first batch, and the visitor's
						// own emergency number survives the helpline number guard. (CUR-4061)
						crisisSupport: () => Boolean(message.moderation?.support),
						helplineCountry: countryFromHeader(request.headers.get("x-vercel-ip-country")),
						// The country the message names, once the support classifier has read it. Read per
						// batch, like crisisSupport, since the stamp can land while the answer streams. (CUR-4488)
						namedHelplineCountry: () => message.moderation?.supportCountry,
						// The end-of-stream number pass waits for the classifier's stamp, so a short answer that beats it
						// is still guarded (the stubbed crisis answer in crisis-number-guard.spec.ts did).
						crisisSupportSettled: () => supportVerdict,
						// re-answer ungrounded before falling back to the static sources-pointer, when
						// this turn's whole grounded answer bails to a hedge. Flag-gated (grounded-bail-regen) —
						// whenAbsent leaves today's always-pointer behavior unchanged. See groundedBailRegen.ts.
						// The regen re-answers with retrieval cleared, which only a pipeline turn has to clear: a
						// native turn would run its tools again rather than answer ungrounded (CUR-2697). (CUR-148)
						onGroundedBail:
							harness.retrieval === "pipeline" &&
							groundedBailRegenEnabled() &&
							faultInjection !== "grounded_answer_hedges"
							? async () => {
									if (outputLedger?.stopped) return undefined;
									return screenedRegen(await runGroundedBailRegen(ctx, ctrl.signal));
								}
							: undefined,
						// An answer that recites the fenced turn's preamble is asked once more, sources
						// kept, and the retry passes the same output screen as any regen. (CUR-3886)
						onRecital: async () => {
							if (outputLedger?.stopped) return undefined;
							return screenedRegen(await runRecitalRegen(ctx, ctrl.signal));
						},
						onNotice: (notice) => {
							if (notice.labelCount > 0) message.labelNotice = { count: notice.labelCount };
							if (notice.urlCount > 0) {
								message.urlNotice = { count: notice.urlCount, urls: notice.urls.slice(0, 8) };
							}
							if (notice.sourceRemovedChars > 0) {
								logger.info(
									{ grounded: groundedTurn, removedChars: notice.sourceRemovedChars },
									"[sourceGuard] stripped fabricated source list/disclaimer/unbacked claim"
								);
								message.sourceNotice = { removedChars: notice.sourceRemovedChars };
							}
							if (notice.finalMutations.length > 0) {
								const lastMutation = notice.finalMutations[notice.finalMutations.length - 1];
								// Either shape of the grounded-hedge bail counts as "the original answer was
								// discarded" for the outcome log and the citation audit (auditCitations' own
								// `replacedByGuard` exclusion) — a fresh ungrounded regen is exactly as much "not
								// the model's grounded answer" as the static pointer is.
								const groundedHedgeMutation = notice.finalMutations.find(
									(m) => m.guard === "groundedHedgeReplacement" || m.guard === "groundedHedgeUngroundedRegen"
								);
								guardReplacedAnswer = !!groundedHedgeMutation;
								// The regen case shipped a real, if ungrounded, model answer — not
								// nothing. Kept separate from guardReplacedAnswer above (which stays broad for
								// the citation audit's own valid reason to exclude both shapes). (CUR-192)
								answerRecoveredByRegen =
									groundedHedgeMutation?.guard === "groundedHedgeUngroundedRegen";
								// Stamp the message so the provenance trace's corrections list can report this
								// honestly on reload — `guardReplacedAnswer` above only reaches the outcome log
								// and the citation audit, never the message itself (CUR-148).
								if (groundedHedgeMutation) {
									message.groundedHedgeNotice = {
										kind: answerRecoveredByRegen ? "regen" : "pointer",
										sourceCount: honestySources.length,
									};
								}
								// FIRST mutation's before-length: that is the text as the model produced it,
								// ahead of every guard in the chain. Taking the last one would measure the
								// second-to-last guard's output and report it as the model's. EXCEPT when that
								// first mutation is a successful regen recovery — there, `beforeChars` is the
								// FAILED grounded attempt's length (typically 0), not what the model ultimately
								// wrote; `afterChars` is the real, regenerated answer the user actually received.
								preGuardChars = answerRecoveredByRegen
									? groundedHedgeMutation?.afterChars ?? null
									: notice.finalMutations[0]?.beforeChars ?? null;
								logger.info(
									{
										grounded: groundedTurn,
										beforeChars: notice.finalMutations[0]?.beforeChars,
										afterChars: lastMutation?.afterChars,
										mutations: notice.finalMutations,
									},
									"[honesty] final-only mutations"
								);
							}
						},
					});
					// Groundcheck (CUR-2467) for both harnesses, after the output screen and the honesty
					// stream, so its deletions are the text that ships. Deletion-only, so every word left has
					// already cleared the screen. Native retrieval is read from what its tool calls returned;
					// a scaffolded turn's from the pipeline's own retrieval. (CUR-2765)
					// `groundcheck_removes_claim` checks the canned reply against fixed evidence with a stub
					// detector and reviser, whatever the flag, so a spec reads the count the stamp carries. (CUR-2927)
					const groundcheckFault = faultInjection === "groundcheck_removes_claim";
					const answerSource = groundcheckStage(honestySource, {
						enabled: groundcheckFault || groundcheckEnabled(),
						...(groundcheckFault ? { check: groundcheckFaultCheck } : {}),
						question: userTextToRag,
						standDown: () =>
							!!outputLedger?.stopped ||
							!!mathLedger ||
							!!ctx.nativeGrounding?.calculated ||
							!!message.groundedHedgeNotice,
						evidence: async () =>
							groundcheckFault
								? GROUNDCHECK_FAULT_EVIDENCE
								: groundcheckEvidence({
								retrieved: ctx.nativeGrounding
									? ctx.nativeGrounding.evidence
									: [
											message.rag ? ragContext?.evidence : undefined,
											groundedWeb ? webSearchCtx?.evidence : undefined,
										],
								attached: await preparedMediaPromise.catch(() => undefined),
							}),
						sources: () => ctx.nativeGrounding?.sources ?? honestySources,
						onOutcome: (outcome, beforeChars, removed) => {
							message.groundcheckNotice = removed === undefined ? { outcome } : { outcome, removed };
							// The model's own length, for the outcome ladder, when no honesty guard recorded one.
							if (beforeChars !== undefined && preGuardChars === null) preGuardChars = beforeChars;
						},
					});
					for await (const event of answerSource) {
						// Terminal boundary: once finalization has begun, a late clear
						// batch must not be applied — update() mutates the persisted answer even after the client
						// check and detached updates still persist, so stop before update().
						if (outputLedger?.stopped) break;
						await update(event);
					}
					if (turnPolicy.outputModerationEnabled) {
						// Transport the output-screen verdict to the live client (it is otherwise only persisted,
						// so the map/trace would miss an output block until a full reload). Distinct from the input
						// Safety update — an output block means the model RAN, so it must not render as an input
						// decline. The client stamps message.outputModeration from this; reveal/trace then match
						// the post-reload view. Skipped on abort (no honest verdict for a turn the user cut off).
						if (message.outputModeration && !ctrl.signal.aborted) {
							await update({
								type: MessageUpdateType.OutputSafety,
								flagged: message.outputModeration.flagged,
								kind: message.outputModeration.kind,
								label: message.outputModeration.label,
								score: message.outputModeration.score,
								screened: message.outputModeration.screened,
								...(message.outputModeration.truncated ? { truncated: true } : {}),
								...(message.outputModeration.ruleLabel
									? { ruleLabel: message.outputModeration.ruleLabel }
									: {}),
								...(message.outputModeration.unscreened ? { unscreened: true } : {}),
								...(message.outputModeration.rechecked
									? { rechecked: message.outputModeration.rechecked }
									: {}),
							});
						}
					}
					// The OUTPUT screen can also refuse, after the model has already run (whole answer
					// withheld, or a clean prefix kept and the rest truncated — `flagged` is false on the
					// cleared path, so this is a real block either way). Recorded with the same outcome so
					// "the user was refused" is one signal, and separated by `declinedAt` because the model
					// DID run here — turnTotalMs and firstTokenReached mean something different than on an
					// input decline. Read unconditionally, not inside the outputModerationEnabled() branch
					// above: that gate gates the CLIENT update, and the outcome must stay honest regardless.
					if (message.outputModeration?.flagged) {
						declineKind = message.outputModeration.kind;
						declinedAt = "output";
					}
					// A watchdog timeout is never a user choice: it gets the SAME treatment as the catch block's
					// timedOut branch (partial credit via emitInterruptedFinalAnswer, then a real error). Setting
					// abortedByUser here would route a stalled or empty turn through every abortedByUser-gated path
					// meant for a real Stop click, including the "no output generated -> error" check further down
					// (guarded on !abortedByUser), and the empty turn would persist as delivered.
					if (ctrl.signal.aborted) {
						if (timedOut) {
							if (!state.finalAnswerReceived) {
								await emitInterruptedFinalAnswer();
								hasError = true;
								await update({
									type: MessageUpdateType.Status,
									status: MessageUpdateStatus.Error,
									message: watchdogTimedOutMessage(
										messageToWriteTo?.updates,
										generationUpdatesFrom,
										model.displayName ?? model.name
									),
									statusCode: 504,
								...(watchdogModelSilent && { modelSilent: true }),
								});
							} else {
								// `fireStall` above already skips aborting once finalAnswerReceived is
								// true, but that check and this one race — the model's last chunk can finish and
								// the watchdog's setTimeout can fire in the gap before the harness's own await
								// chain (moderation screen, then update()) gets around to flipping the flag. By
								// the time execution reaches HERE, the flag has caught up even though `timedOut`
								// already latched true from that stale read. Same guard as the hard-deadline
								// branch below: leave hasError false so the fall-through Finished status sends
								// normally instead of clobbering a delivered answer with a 504 nobody asked for. (CUR-1767)
								logger.error(
									{ conversationId: conversationKey },
									"[generation] watchdog fired after final answer — leaving a delivered turn to finish normally"
								);
							}
						} else {
							abortedByUser = true;
							if (!state.finalAnswerReceived) {
								await emitInterruptedFinalAnswer();
							} else if (messageToWriteTo.interrupted) {
								// With output screening on, screenStream answers the abort itself with
								// every chunk it had released, which can run well past what the stopping client
								// had shown. That FinalAnswer skips emitInterruptedFinalAnswer, so clamp here. (CUR-2300)
								await clampToStopPoint();
							}
						}
					}
				} // end else: message was not declined by the safety pre-screen
			} catch (e) {
				const err = e as Error;
				const isAbortError =
					err?.name === "AbortError" ||
					err?.name === "APIUserAbortError" ||
					// The OpenAI SDK's APIUserAbortError keeps name "Error", so
					// match the class name too
					err?.constructor?.name === "APIUserAbortError" ||
					err?.message === "Request was aborted.";
				if ((isAbortError || ctrl.signal.aborted) && !timedOut) {
					// A genuine USER stop (not the watchdog): keep the partial text as an interrupted answer.
					abortedByUser = true;
					logger.info({ conversationId: conversationKey }, "Generation aborted by user");
					if (!state.finalAnswerReceived) {
						await emitInterruptedFinalAnswer();
					} else if (messageToWriteTo.interrupted) {
						// A screened turn already sent its own interrupted FinalAnswer; see above. (CUR-2300)
						await clampToStopPoint();
					}
				} else if ((isAbortError || ctrl.signal.aborted) && timedOut) {
					// A watchdog-killed turn gets the same "here's what finished" treatment as a
					// user-initiated stop (CUR-1178). summarizeInterruptedAgentWork exists for a turn that
					// stalls mid tool-use, which is what the watchdog's silence trigger catches, as well as
					// the click-Stop case. Reports the timeout as an error status below ONLY when no answer
					// reached the client (CUR-1767); a delivered turn falls through to the normal Finished
					// status instead, the same guard the hard-deadline branch applies.
					if (!state.finalAnswerReceived) {
						await emitInterruptedFinalAnswer();
						hasError = true;
						await update({
							type: MessageUpdateType.Status,
							status: MessageUpdateStatus.Error,
							message: watchdogTimedOutMessage(
										messageToWriteTo?.updates,
										generationUpdatesFrom,
										model.displayName ?? model.name
									),
							statusCode: 504,
						...(watchdogModelSilent && { modelSilent: true }),
						});
						logger.error(err, "Error in conversation stream");
					} else {
						logger.error(
							err,
							"[generation] watchdog fired after final answer — leaving a delivered turn to finish normally"
						);
					}
				} else {
					hasError = true;
					// Extract status code if available from HTTPError or APIError.
					const errObj = err as unknown as Record<string, unknown>;
					const statusCode =
						(typeof errObj.statusCode === "number" ? errObj.statusCode : undefined) ||
						(typeof errObj.status === "number" ? errObj.status : undefined);
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						// A model host's 429 gets busy copy naming the model, and CUR-2628 a stream that
						// closed mid-answer gets its own, and CUR-2829 anything else a plain sentence; the raw SDK text
						// stays in the log. CUR-2893: a message too long for the model is refused before any call. (CUR-2307)
						// A model that sent nothing by its give-up gets the watchdog's sentence, sooner. (CUR-3939)
						message:
							messageTooLongMessage(err, model.displayName ?? model.name) ??
							upstreamSilentMessage(err, model.displayName ?? model.name) ??
							upstreamBusyMessage(err, model.displayName ?? model.name) ??
							upstreamDroppedMessage(err, model.displayName ?? model.name) ??
							upstreamFailedMessage(model.displayName ?? model.name),
						...(statusCode && { statusCode }),
						...(err instanceof NoFirstChunkError && { modelSilent: true }),
					});
					logger.error(err, "Error in conversation stream");
				}
			} finally {
				cancelGenWatchdog();
				clearInterval(silenceWatchdog);
				if (retrievalHeartbeat) clearInterval(retrievalHeartbeat);
				// check if no output was generated
				if (!hasError && !abortedByUser && messageToWriteTo.content === initialMessageContent) {
					hasError = true;
					logger.warn(
						{
							conversationId: conversationKey,
							updatesCount: messageToWriteTo.updates?.length ?? 0,
							filesCount: messageToWriteTo.files?.length ?? 0,
							reasoningLen: messageToWriteTo.reasoning?.length ?? 0,
							initialLen: initialMessageContent.length,
							finalLen: messageToWriteTo.content.length,
						},
						"No output generated after streaming; emitting error status"
					);
					await update({
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						// The same notice as a lane that failed outright, naming the model and
						// offering Retry; the cause stays in the warn above. (CUR-4200)
						message: upstreamFailedMessage(model.displayName ?? model.name),
					});
				}
				// Exit path 1 (normal / block / producer error / abort, after the
				// regen has run): drain the ledger and emit the ONE output report. Memoized, so a later
				// cancel()/hard-deadline converge on this same run; awaited so the report completes before the
				// function ends on the no-waitUntil path (dev/tests). Bounded, never rejects.
				await finalizeOutput?.();
			}

			// Name-adoption guard (post-generation). Prompt rules don't reliably stop the model adopting
			// a personal name for itself, so enforce it at runtime: if this turn's answer adopted one,
			// stamp the marker (an honest "no name" chip renders, and later turns strip the name from
			// context so it can't compound). See $lib/chat/server/nameGuard.
			if (!hasError && !abortedByUser) {
				const lastUserText =
					[...messagesForPrompt].reverse().find((m) => m.from === "user")?.content ?? "";
				const nameCheck = detectNameAdoption({
					userText: lastUserText,
					assistantText: messageToWriteTo.content.slice(initialMessageContent.length),
					servedModelId: messageToWriteTo.routerMetadata?.model || model.id,
				});
				if (nameCheck.adopted) {
					messageToWriteTo.nameNotice = { name: nameCheck.name };
					await update({ type: MessageUpdateType.NameNotice, name: nameCheck.name });
				}
			}

			// (Recency-hedge, citation/label, URL, and source-claim cleaning happen per-chunk in
			// honestyScreenStream, BEFORE a token ever reaches update() — see the generation call above and
			// $lib/chat/server/textGeneration/honestyStream.ts. So content, the persisted updates[] log, and
			// the live client never diverge for those checks in the first place.)

			// A layer-test turn reports the switches it actually applied, read by the runner. (CUR-2139)
			const evalApplied = evalLayers() ? (appliedEvalLayers() ?? {}) : undefined;
			if (evalApplied) logger.info({ requested: evalLayers(), applied: evalApplied }, "[eval-layers]");
			if (!hasError && !state.finishedStatusSent) {
				await update({
					type: MessageUpdateType.Status,
					status: MessageUpdateStatus.Finished,
					...(evalApplied ? { evalLayers: evalApplied } : {}),
				});
			}

			// Real turn-relative timings for the request-trace (the only latency we measure): request-start
			// (promptedAt) → first answer token, and → done. Stamped only when the model actually streamed
			// (firstTokenAt set), so a declined/cache turn carries no fabricated timing.
			if (!hasError && !abortedByUser && state.firstTokenAt) {
				const ttftMs = state.firstTokenAt.getTime() - promptedAt.getTime();
				// screenHoldMs = the hold between the model's first RAW token (rawFirstTokenMs, stamped in
				// textGeneration) and the first RELEASED token (ttftMs): output-screen first-chunk hold +
				// honesty/sentence accumulation. Clamp >=0 to guard clock skew. The tail Phase 4 targets.
				//
				// First-chunk hold: p50 519ms, p90 1,070ms, 16% of TTFT over 1,012 production turns.
				// With OUTPUT_MODERATION false in prd the output-screen term is ZERO, so all of it is
				// honestyStream waiting on nextChunk. Dividing the hold by each turn's own generation rate
				// (0.148 chars/ms p50) puts the implied first chunk at 83 chars p50, with 72% in the 40-150
				// band and 1 turn in 1,012 at the 400-char cap: the wait is the model emitting one sentence,
				// not our compute. So screenStream's FIRST_CHUNK_CHARS fast path would buy nothing here, and
				// the only levers are a faster generation rate or releasing sub-sentence, which costs the
				// honesty guards their ability to retract.
				// Turning OUTPUT_MODERATION on adds a Coop round trip on top of this, in front of the first
				// visible byte: it is a TTFT decision as much as a safety one.
				if (turnSpans.rawFirstTokenMs != null) {
					turnSpans.screenHoldMs = Math.max(0, ttftMs - turnSpans.rawFirstTokenMs);
				}
				messageToWriteTo.timings = {
					ttftMs,
					totalMs: Date.now() - promptedAt.getTime(),
					// DURABLE phase split — persisted on the message so the slow phase is queryable from the
					// DB/trace, no ephemeral-log tailing (gateMs = safety pre-screen, now concurrent with
					// retrieval; retrievalMs = RAG + open-web; ragMs = RAG alone).
					...(gateMs != null ? { gateMs } : {}),
					...(ragMs != null ? { ragMs } : {}),
					...(totalRetrievalMs != null ? { retrievalMs: totalRetrievalMs } : {}),
					// The web-search mode (off / auto / always) this turn ran under, durable on the turn. (CUR-4274)
					webSearchMode,
					// Full decomposition captured by the per-turn span sink (SyftHub stages, generation pre-passes,
					// the dual first-token stamp incl. screenHoldMs, and output screening). Every field is optional,
					// so a phase that didn't run is simply absent. Spread last; keys are disjoint from those above.
					...turnSpans,
				};
				if (turnRungs.length > 0) messageToWriteTo.rungs = turnRungs;
				// TTFT decomposition — the measurement that settles "slow retrieval vs cold endpoint".
				// ttftMs spans request-start → first token, so it includes BOTH the retrieval phase and
				// the model endpoint's own first-token latency. Subtract the measured retrieval wall-clock
				// to isolate endpointTtftMs: a large endpointTtftMs with a small totalRetrievalMs is an
				// endpoint cold-start (scale-from-zero / weight load), NOT our retrieval pipeline.
				// Which serving lane this turn was routed to. The OPENAI_PROVIDER value is write-only in the
				// Vercel dashboard (we can't read it back), but the server process CAN read its own env at
				// runtime — so this log is the only way to observe the lane we're pinned to. providerPin = the
				// raw env pin ("publicai" warm lane, "auto"/empty = router picks, can land on cold
				// featherless). All non-secret (names + host, never a key).
				//
				// baseHost + resolvedModelId both come off THE SERVING MODEL'S OWN endpoint, never the global
				// config — see describeServingLane, which carries the why and the one limit (it reports the
				// lane we ROUTED to, not the one that answered after a failover).
				const { baseHost, resolvedModelId } = describeServingLane(
					model,
					config.OPENAI_BASE_URL,
					config.OPENAI_PROVIDER
				);
				logger.info(
					{
						conversationId: conversationKey,
						ttftMs,
						totalRetrievalMs: totalRetrievalMs ?? null,
						endpointTtftMs: totalRetrievalMs != null ? ttftMs - totalRetrievalMs : null,
						model: model.id,
						providerPin: config.OPENAI_PROVIDER ?? null,
						resolvedModelId,
						baseHost,
					},
					"[ttft] decomposition"
				);
			}

			// ── Persist + finalize, INSIDE the raced work ─────────────────────────────────────────
			// Deliberately inside generationWork so the hard deadline covers it: persistConversation is
			// queued on the per-request write chain, and a WEDGED earlier link (a DB write that never
			// settles) would otherwise hang this await after the race already resolved — an unbounded
			// tail the deadline could no longer save, leaving the claim orphaned until the platform
			// kill. If the emergency path already finalized the turn (deadline won while we were stuck
			// here or earlier), the resumed zombie must write NOTHING: no stale full-doc persist over a
			// possibly-retried turn, no finishGeneration overwrite of the emergency verdict.
			if (turnFinalized) return;
			// The support signal's own timeout bounds this; it never rejects.
			await supportVerdict;
			await persistConversation();
			// Re-check AFTER the persist await: in the wedged-chain case the zombie suspends on the link
			// above, the hard deadline finalizes and releases the W2 id, and the chain later unwedges —
			// resuming us HERE, past the first guard. A late finishGeneration would overwrite the
			// emergency 'error' verdict (possibly with 'complete') and steal a retry's re-claim.
			if (turnFinalized) return;
			// W2: mark this generation terminal. 'complete' covers a user-interrupted turn too (a final
			// answer was persisted); 'error' leaves the id re-claimable by a fresh retry of the same turn
			// (claimGeneration's WHERE status='error'). Best-effort: a failure here must not break the run.
			if (generationId) {
				await finishGeneration(generationId, hasError ? "error" : "complete").catch((err) =>
					logger.warn(err, "Failed to finalize generation idempotency record")
				);
			}
			// Consume the stop marker once the stop has been honored and the interrupted state
			// persisted. Markers are conversation-scoped, so a leftover would trip the watcher of the
			// next generation; consuming here (instead of unconditionally deleting in pre-flight) keeps
			// markers alive long enough for concurrent in-flight generations to observe them.
			if (abortedByUser) {
				await collections.abortedGenerations
					.deleteOne({ conversationId: convId })
					.catch((err) => logger.warn(err, "Failed to consume stop marker"));
			}
			};

			// ── Hard deadline (the backstop the watchdog's abort can't be) ──────────────────────────
			// The watchdog aborts at genTimeoutMs; a well-behaved upstream then unwinds through
			// generationWork's own catch/finally and the race settles normally. The grace window is how
			// long we give that unwind. Past it, the stream provably isn't going to release control on
			// its own — take it back, emit a terminal retryable 504, and run a BOUNDED version of the
			// persist/finalize tail (the dependency that hung may be the same one cleanup needs).
			// (HARD_UNWIND_GRACE_MS is a ladder rung — see $lib/chat/utils/deadlineLadder.)
			// -- Run generation, bounded by the hard deadline --
			// The admission gate above already decided `admitted` and a shed turn emitted its 503 pre-accept,
			// so it has nothing to generate and simply falls through to the cleanup tail. An admitted turn runs
			// generationWork raced against the hard deadline (the backstop the watchdog's abort can't be). The
			// slot taken above is released in this block's `finally`.
			try {
				if (admitted) {
					const work = generationWork();
					// The abandoned promise may reject long after we've moved on (e.g. its catch path throws
					// once its DB call finally fails) - that must never surface as an unhandled rejection.
					work.catch(() => {});
					await raceScreenAwareDeadline(work, genDeadline, HARD_UNWIND_GRACE_MS);
				}
			} catch (e) {
				if (!(e instanceof GenerationDeadlineExceeded)) throw e; // a genuine route bug — same surface as before
				timedOut = true;
				try {
					ctrl.abort(new GenerationWatchdogAbort());
				} catch {
					// already aborted by the watchdog
				}
				// The zombie's finally will never run — clear ITS timers here, or the retrieval
				// heartbeat would keep enqueueing into a closed stream (and persisting) forever.
				cancelGenWatchdog();
				clearInterval(silenceWatchdog);
				if (retrievalHeartbeat) clearInterval(retrievalHeartbeat);
				if (state.finalAnswerReceived) {
					// The answer already reached the client — the hang is in TRAILING work (audio
					// synthesis, usage accounting, a trailing provider chunk). Mirror the watchdog's
					// finalAnswerReceived guard: finish the turn as DELIVERED, never clobber a good
					// answer with a 504.
					logger.error(
						{ conversationId: conversationKey, genTimeoutMs, graceMs: HARD_UNWIND_GRACE_MS },
						"[generation] hard deadline after final answer — bounded-finalizing a delivered turn"
					);
					if (!state.finishedStatusSent) {
						await boundedSettle(
							update({ type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished }),
							EMERGENCY_CLEANUP_BUDGET_MS
						);
					}
				} else {
					hasError = true;
					logger.error(
						{ conversationId: conversationKey, genTimeoutMs, graceMs: HARD_UNWIND_GRACE_MS },
						"[generation] hard deadline: stream never unwound after abort — forcing terminal error"
					);
					await boundedSettle(
						update({
							type: MessageUpdateType.Status,
							status: MessageUpdateStatus.Error,
							statusCode: 504,
							message: "The request took too long to respond. Please try again.",
						}),
						EMERGENCY_CLEANUP_BUDGET_MS
					);
				}
				// From here the turn is finalized: the abandoned zombie must not mutate the message or
				// trigger detached persists if its hung await ever resumes — update() no-ops on this,
				// and the persist/finalize tail inside generationWork returns without writing.
				turnFinalized = true;

				// Exit path 3: the abandoned generationWork's finally (exit 1)
				// may never run, so drain the output ledger and emit the ONE report here. turnStopped seeds
				// the terminal boundary; bounded by the emergency budget so a hung screen cannot wedge cleanup.
				turnStopped = true;
				if (finalizeOutput) await boundedSettle(finalizeOutput(), EMERGENCY_CLEANUP_BUDGET_MS);

				// Best-effort AND bounded: whatever hung the turn may be exactly what these calls need.
				// The persist is queued on the per-request write chain, which may be the wedged thing
				// itself — if it doesn't run within the budget it is ABANDONED (the closure no-ops when
				// the chain later unwedges), because by then the id below is already marked re-claimable
				// and a retry may have written a newer turn this stale full-doc write would clobber.
				const persistOutcome = await Promise.race([
					persistConversation().then(() => "done" as const),
					new Promise<"timeout">((resolve) =>
						setTimeout(() => resolve("timeout"), EMERGENCY_CLEANUP_BUDGET_MS)
					),
				]);
				if (persistOutcome === "timeout") persistAbandoned = true;
				// 'error' leaves the W2 id re-claimable by a retry; a delivered answer finishes 'complete'.
				// finishGeneration writes the generations table DIRECTLY (not through the wedged chain).
				if (generationId) {
					await boundedSettle(
						finishGeneration(generationId, hasError ? "error" : "complete"),
						EMERGENCY_CLEANUP_BUDGET_MS
					);
				}
				// The emergency budget must not abandon review work on Vercel without waitUntil.
				// Finish the bounded DB cleanup first, then preserve the complete drain/report lifetime.
				if (finalizeOutput) await runInBackground(finalizeOutput.settled);
			} finally {
				// Release the admission slot exactly once. Guarded by `admitted` so a shed turn (which
				// never took a slot) is a no-op; the gate clamps at 0 regardless.
				if (admitted) releaseGenerationSlot();
			}

			clearInterval(abortMarkerWatcher);
			abortRegistry.unregister(conversationKey, ctrl);

			// Terminal turn record — the ONLY end-to-end wall-clock we emit. Everything else we log
			// stops at the first token (ttftMs, endpointTtftMs, genToFirstTokenMs, rawFirstTokenMs), so
			// only this record lets a deadline in the ladder be validated against real traffic. `totalMs`
			// from the timings stamp above exists only on the success path and is persisted, not logged;
			// this record covers every outcome.
			//
			// Emitted on EVERY outcome, which is the point: the interesting turns are the ones that
			// didn't finish. `outcome` separates slow-but-successful from stalled, so raising a deadline
			// can be judged on the distribution rather than on the ceiling arithmetic.
			//
			// turnTotalMs spans request-start → terminal (prestream chain included). genElapsedMs spans
			// only what the watchdog itself measures, so it's directly comparable to genTimeoutMs.
			// See $lib/chat/utils/deadlineLadder for what each bound is supposed to be.
			// The ladder is a PRECEDENCE CHAIN and lives in $lib/chat/utils/outcomeLadder — a turn can
			// satisfy several rungs at once, and each rung's position is an argument (why `declined` sits
			// below the failures and above `complete`; why `empty` sits below `declined`). Keeping it in one
			// module gives the ordering its own tests and lets warm.ts read the same taxonomy for the alert.
			//
			// `lengths` is hoisted out of the log payload below because the ladder needs modelChars:
			// `empty` is the rung the honesty guard had made unreachable (CUR-445). Sliced from
			// initialMessageContent like lines 1078 and 1833, NOT because the prefix is ever non-empty
			// today — appendTurnMessages creates every assistant message with `content: ""` — but because
			// preGuardChars is this turn's text while content is the whole message. The two numbers are
			// only comparable if they measure the same span, and relying on the prefix being empty makes
			// that an accident rather than a property.
			const lengths = answerLengths(
				messageToWriteTo.content.slice(initialMessageContent.length),
				preGuardChars
			);
			const turnOutcome = classifyTurnOutcome({
				abortedByUser,
				admitted,
				timedOut,
				hasError,
				declineKind,
				// The same flag the citation audit already reads, for the same reason: it is the one
				// place that knows our copy went out instead of an answer. See outcomeLadder.ts for why
				// this and not a length carries the rung. EXCLUDING the regen-recovered case (CUR-192):
				// guardReplacedAnswer is deliberately broad (both shapes are "not the model's grounded
				// answer" for the citation audit), but only buildGroundedHedgeReplacement's bare pointer
				// means the user got nothing — the regen shipped a real, if ungrounded, answer.
				answerSubstituted: guardReplacedAnswer && !answerRecoveredByRegen,
				modelChars: lengths.modelChars,
				// screenStream.ts's phase-deadline trip (CUR-1657) sets `screened: false` on
				// exactly this branch and no other (see screenOutputStream's onModeration calls) — the one
				// unambiguous signal that this turn's canned decline text, not a real answer, is what
				// landed in modelChars above. (CUR-1727)
				outputScreenTimedOut: message.outputModeration?.screened === false,
			});
			logger.info(
				{
					conversationId: conversationKey,
					outcome: turnOutcome,
					// null on every non-declined turn, so an alert can filter on the kind without
					// re-deriving it, and `child_safety` — the fail-closed outage signature — is greppable
					// on its own rather than hidden inside an aggregate non-`complete` rate.
					declineKind,
					declinedAt,
					turnTotalMs: Date.now() - promptedAt.getTime(),
					genElapsedMs: Date.now() - genWatchdogArmedAt,
					genTimeoutMs,
					// The resolved silence-window this turn armed, alongside the total backstop above
					// — lets a reader tell which one WOULD have caught a stall without cross-referencing code. (CUR-58)
					silenceTimeoutMs,
					// `firstTokenReached` means the stream OPENED, not that text arrived: a turn that writes
					// zero characters can log it true (CUR-443). These two say how much was actually
					// written. `modelChars: 0` also puts the turn on the `empty` rung above; the SIZE of a
					// non-zero answer is report-only, and answerLength.ts has why a floor is not set yet.
					...lengths,
					firstTokenReached: state.firstTokenAt != null,
					// routerMetadata.model carries the ACTUAL served model when the gateway substitutes a lane for
					// the requested one (CUR-874). Logging the requested model.id would credit a model that never
					// ran, in this outcome and in every alert/metric built on it. On a healthy turn
					// routerMetadata.model already equals model.id (endpointOai.ts's "harmless no-op"), so
					// preferring it here changes nothing except the substituted case.
					model: messageToWriteTo.routerMetadata?.model || model.id,
					// Both grounding prompts instruct the model to cite every claim inline with [n].
					// `citeUncited: true` is a grounded turn that cited none of the sources it was handed — the
					// alertable case, and one that differs by checkpoint. Reported, never enforced: an uncited
					// answer is still an answer.
					...(() => {
						const a = auditCitations({
							text: messageToWriteTo.content,
							rag: messageToWriteTo.rag,
							webSearch: messageToWriteTo.webSearch,
							replacedByGuard: guardReplacedAnswer,
						});
						return a.grounded
							? {
									citeSources: a.sourceCount,
									citeMarkers: a.citationCount,
									citeDistinct: a.distinctCited,
									// `[n]` naming a source that was never in the context. Its own field, not folded into
									// citeMarkers: counting a fabricated marker as compliance would hide the turn from
									// citeUncited entirely.
									citeDangling: a.danglingCount,
									citeUncited: a.uncited,
								}
							: {};
					})(),
				},
				"[turn] outcome"
			);

			// Mirror the outcome into Postgres so the warm cron can alert on the RATE of
			// non-complete turns. The log line above lives in Axiom, which the cron cannot read, and
			// generations.status can't stand in (an interrupted/empty turn is 'complete' there). Through
			// runInBackground, NOT a bare fire-and-forget: this fires at finalization, and a floating promise
			// would be frozen out on Vercel before the write lands — undercounting the denominator. waitUntil
			// keeps the function alive until it settles, and the response is never delayed.
			// Written with the first-token time (CUR-2243), so the warm cron can also see answers that finish slowly.
			void runInBackground(
				recordTurnOutcome(turnOutcome, declineKind ?? null, messageToWriteTo.timings?.ttftMs ?? null)
			);

			// used to detect if cancel() is called bc of interrupt or just because the connection closes
			turnFinalized = true;
			doneStreaming = true;
			if (!clientDetached) {
				try {
					controller.close();
				} catch {
					// A hard-timeout emergency close can race an already-errored/closed controller; a
					// double-close must not crash start() this late.
				}
			}
		}),
		async cancel() {
			if (doneStreaming) return;
			clientDetached = true;
			// Exit path 2: seed the terminal boundary (turnStopped also stops a
			// ledger a still-running prestream may create) and START the finalizer BEFORE persist?.(), so its
			// bounded drain never queues behind the unbounded DB write; await both.
			turnStopped = true;
			const fin = finalizeOutput?.();
			// null until the chain has run — a disconnect during the prestream phase has written
			// nothing turn-specific yet, so there is nothing to persist.
			await persist?.();
			await fin;
		},
	});

	// The response returns without waiting for the message save to finish, so a save error does not
	// reach the client.
	return new Response(stream, {
		headers: {
			"Content-Type": "application/jsonl",
			// Prod serves this stream through TWO Vercel layers (the map-site project proxies
			// /chat/* to this one) — tell every intermediary not to buffer or transform it, so
			// tokens reach the client as they are enqueued instead of in bursty catch-up flushes.
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
			// Names the fault this turn simulated, so a spec can tell "the app survived the
			// fault" from "the fault never reached the server". Only present when resolveFaultInjection
			// accepted the caller's secret, which is preview/development only. (CUR-1884)
			...(faultInjection ? { "X-Fault-Injected": faultInjection } : {}),
			...(replayMode ? { "X-Model-Replay": replayMode } : {}),
			...(fakeAgent ? { "X-Agent-Service": "fake" } : {}),
		},
	});
}

export async function DELETE({ locals, params }) {
	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// FK-ordered cascade (reports/files before the conversation) — a bare deleteOne throws once
	// the conversation has a report (NOT NULL FK to conversations.id).
	await deleteConversationsCascade(
		[conv._id.toString()],
		conv.userId?.toString(),
		conv.userId ? undefined : conv.sessionId
	);
	await tombstoneConversations(locals, [conv]);

	return new Response();
}

export async function PATCH({ request, locals, params }) {
	// Per-request: THIS user's effective registry (catalog + their own local endpoint, if any), not the
	// module-level validModelIdSchema alone — otherwise pinning a conversation to a local model would
	// 400 here.
	const effectiveValidModelIdSchema = await getEffectiveValidModelIdSchema(locals);
	// A bad title or model id is the caller's mistake, so it answers 400. `.parse` threw a
	// ZodError that SvelteKit answered 500. (CUR-3699)
	const parsed = z
		.object({
			title: z.string().trim().min(1).max(100).optional(),
			model: effectiveValidModelIdSchema.optional(),
		})
		.safeParse(await request.json().catch(() => undefined));
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "Invalid request");
	}
	const values = parsed.data;

	const convId = new ObjectId(params.id);

	const conv = await collections.conversations.findOne({
		_id: convId,
		...authCondition(locals),
	});

	if (!conv) {
		error(404, "Conversation not found");
	}

	// Only include defined values in the update, with title sanitized
	const updateValues = {
		...(values.title !== undefined && {
			title: values.title.replace(/<\/?think>/gi, "").trim(),
			...syncBump(locals),
		}),
		...(values.model !== undefined && { model: values.model }),
	};

	await collections.conversations.updateOne(
		{
			_id: convId,
		},
		{
			$set: updateValues,
		}
	);

	// Best-effort only (CUR-1194): give a cold local instance a head start on a mid-conversation model
	// switch. No-ops instantly for any non-local model. Routed through runInBackground, not a bare
	// `void` — a fire-and-forget promise in a Vercel Node function is frozen the instant the response
	// returns (vercelBackground.ts's own module comment), which would silently turn this into a no-op
	// in prod/preview while looking fine in local dev (a long-lived process never freezes anything).
	void runInBackground(prewarmLocalModelForUser(locals, values.model));

	return new Response();
}

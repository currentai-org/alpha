<script lang="ts">
	import ChatWindow from "$lib/chat/components/chat/ChatWindow.svelte";
	import NoModelsAvailable from "$lib/chat/components/NoModelsAvailable.svelte";
	import { consumePendingFiles } from "$lib/chat/utils/pendingFiles";
	import { mergeRouterMetadata } from "$lib/chat/utils/routerMetadata";
	import { isAborted } from "$lib/chat/stores/isAborted";
	import { busyHere, busyNow, markBusyHere, serverBusy, serverBusyNow } from "$lib/chat/routing/busyHere";
	import { AUTO, modelChoice, resolveModel } from "$lib/chat/routing/choice";
	import { catalogByGatewayId } from "$lib/chat/routing/catalog";
	import { failureMarksModelBusy, repickedNote, shouldRepick } from "$lib/chat/routing/repick";
	import { repickWait } from "$lib/chat/stores/repickWait";
	import { onDestroy, onMount, untrack } from "svelte";
	import { page } from "$app/state";
	import { trackEvent } from "$lib/analytics";
	import { beforeNavigate, replaceState } from "$app/navigation";
	import { UrlDependency } from "$lib/chat/types/UrlDependency";
	import { safeInvalidate } from "$lib/chat/utils/safeInvalidate";
	import { wipeCommitted, wipeInProgress } from "$lib/chat/stores/deleteAll";
	import { base } from "$lib/chat/paths";
	import {
		activeBenchmarks,
		activeRoutingConfig,
		analysisFor,
		autoRouteFor,
		autoRouteNote,
		nextTurnModel,
		turnModelFor,
		type AutoRouteNote,
	} from "$lib/chat/routing/state";
	import {
		ERROR_MESSAGES,
		error,
		errorHeld,
		isRateLimitMessage,
		sendHeldUntil,
	} from "$lib/chat/stores/errors";
	import { findCurrentModel } from "$lib/chat/utils/models";
	import type { Message } from "$lib/chat/types/Message";
	import {
		searchProvenance,
		moderationMarker,
		ragProvenance,
		mcpProvenance,
		writePolicyProvenance,
		agentToolsProvenance,
		unrunCodeProvenance,
		agentConfirmOpened,
		agentConfirmResolved,
		calculationAppended,
		mcpCallAppended,
	} from "$lib/chat/messageProvenance";
	import { webSearchMode } from "$lib/chat/stores/webSearchMode";
	import { speakMode } from "$lib/chat/stores/speakMode";
	import { agentMode } from "$lib/chat/stores/agentMode";
	import { synthesizingAudioFor, currentPhase } from "$lib/chat/stores/speakState";
	import { pendingChatInput } from "$lib/chat/stores/pendingChatInput";
	import { refusedEdit } from "$lib/chat/stores/refusedEdit";
	import { pendingConfirm, confirmTitle } from "$lib/chat/stores/pendingConfirm.svelte";
	import { get } from "svelte/store";
	import { WEBSEARCH_NODE } from "$lib/chat/components/stack/reveal";
	import {
		MessageUpdateStatus,
		MessageUpdateType,
		SPEAK_STATUS,
		PHASE_PREFIX,
	} from "$lib/chat/types/MessageUpdate";
	import { useConversationsStore } from "$lib/chat/stores/conversations.svelte";
	import { useSessionFootprintStore } from "$lib/chat/stores/sessionFootprint.svelte";
	import { encodeMessageFiles } from "$lib/chat/utils/messageFiles";
	import { addChildren } from "$lib/chat/utils/tree/addChildren";
	import { addSibling } from "$lib/chat/utils/tree/addSibling";
	import {
		fetchMessageUpdates,
		GenerationConflictError,
		GenerationRequestError,
		isLateConnectionLoss,
	} from "$lib/chat/utils/messageUpdates";
	import { getCachedAnswer } from "$lib/chat/utils/starterCache";
	import { v4 } from "uuid";
	import { browser } from "$app/environment";
	import {
		addBackgroundGeneration,
		removeBackgroundGeneration,
		MAX_TRACK_DURATION_MS,
	} from "$lib/chat/stores/backgroundGenerations";
	import type { TreeNode, TreeId } from "$lib/chat/utils/tree/tree";
	import "katex/dist/katex.min.css";
	import { updateDebouncer } from "$lib/chat/utils/updates.js";
	import { loading } from "$lib/chat/stores/loading.js";
	import { clipAudio, playExclusive, stopPlayback } from "$lib/chat/stores/audioPlayback";
	import { streamStart } from "$lib/chat/utils/haptics";
	import { requireAuthUser } from "$lib/chat/utils/auth.js";
	import {
		armSilenceWatchdog,
		classifyWatchdogFire,
		agentRunToReattach,
		agentRunReattachDeadline,
		endsTheTurn,
		handedOffAgentRun,
		reattachView,
		isConversationGenerationActive,
		isGenerationStale,
		serverSnapshotHasAnswer,
		shouldSyncMessagesFromData,
		stoppedTurnMissingFromSnapshot,
	} from "$lib/chat/utils/generationState";
	import { refreshUntilApplied } from "$lib/chat/utils/refreshUntilApplied";
	import { takeStopOnArrival } from "$lib/chat/utils/pendingStop";
	import {
		PENDING_TURN_MAX_MS,
		clearPendingTurn,
		pendingTurnToAwait,
		recordPendingTurn,
	} from "$lib/chat/utils/pendingTurn";
	import { useAPIClient, handleResponse } from "$lib/chat/APIClient";
	import { reportActionHoldCount } from "$lib/chat/stores/reportHold";

	let { data } = $props();

	// Obtain the conversations store during component init (context must be read
	// synchronously, not inside async callbacks or event handlers).
	const convsStore = useConversationsStore();
	// Same rule: read the footprint store during init, use it inside the stream callback.
	const footprint = useSessionFootprintStore();

	let convId = $derived(page.params.id ?? "");
	let pending = $state(false);
	let initialRun = true;
	// Conversation-scoped stop tombstone. A boolean reset on page.params.id
	// changes resurrects the generating UI: invalidation reassigns page.params,
	// which clears the flag while the stopped conversation's snapshot is still
	// non-terminal, flipping $loading back on. Keying the tombstone by
	// conversation id makes it survive invalidations; it expires when a new
	// generation starts in this conversation.
	let stopRequestedFor: string | null = $state(null);
	let stopRequestPromise: Promise<void> | undefined;
	// Id of the generation run this tab started, sent with the generation
	// request and echoed in the stop request so the server can clamp the
	// persisted text to the stop point of the run it belongs to.
	let activeGenerationId: string | undefined;
	// Moves the tokens writeMessage holds for its next frame into the reply's content. The answer
	// renders each token from `updates` as it arrives, a frame before `content` gets it, so Stop calls
	// this before it measures the reply; otherwise a word already on screen falls outside the stop
	// point and is never saved (CUR-3845).
	let commitHeldTokens: (() => void) | undefined;
	// True while writeMessage runs; lets the generation-state effect skip the
	// snapshot-staleness check for the generation streaming in this very tab.
	let writeMessageInFlight = false;
	// Vetoes the data-driven `messages` resync for the full life of a locally-written turn — from
	// submit until the writeMessage finally's post-turn refresh has been OBSERVED to apply (not
	// merely resolved: a SvelteKit invalidate superseded by a newer one resolves WITHOUT applying;
	// see refreshUntilApplied). Deliberately $state and deliberately a TRACKED dependency of the
	// reconcile effect: releasing the hold re-runs the effect, which then applies the by-then-fresh
	// data.messages. Stale loads started mid-turn but delivered later are vetoed at DELIVERY time —
	// sampling a plain boolean at set-time cannot do that (the cross-turn spillage hazard:
	// a mid-stream conversation invalidate swaps `messages` to the server snapshot, orphaning the
	// live stream's write target and painting the PREVIOUS turn's answer under the new prompt).
	// Distinct from `pending` (false at the first token — covers almost nothing) and from
	// `writeMessageInFlight` (cleared before the stop/terminal-persist waits — too early).
	let localTurnSyncHold = $state(false);
	// The turn that raised the hold, so only that turn releases it. The composer re-enables as soon
	// as a turn's finally starts, BEFORE its post-turn refresh has applied, so the next turn can
	// raise the hold while the previous one is still awaiting that refresh. An owner-blind release
	// then dropped the NEW turn's hold, and the previous turn's snapshot (taken before the new user
	// message existed) replaced `messages` mid-stream: the new turn vanished from the screen and its
	// live status log moved onto the previous answer (CUR-1978).
	let localTurnSyncHoldOwner: symbol | undefined;
	// An attach that ended without the run's answer hands its hold here rather than releasing
	// it, so nothing swaps in the server's emptied copy before the next attach; followAgentRun releases it. (CUR-3875)
	const REATTACH_HOLD = Symbol("reattach");
	// Between two attaches to the same run, so a run that keeps cutting off does not loop hot.
	const REATTACH_PAUSE_MS = 1_000;
	// Set by an attach's finally: it ended without the run's answer and the run may still be going.
	let attachWantsAnother = false;
	let messageUpdatesAbortController = new AbortController();
	// Message ids whose fresh audio we've already autoplayed — dedup so the duplicate-generation edge
	// (which completes a turn twice) can't double-play overlapping clips.
	// Dedup guard for autoplay — intentionally non-reactive. Bookkeeping about what has already been
	// played must not trigger a re-render.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	const autoplayedAudioIds = new Set<string>();
	// Set to the conversation id when writeMessage left an UNPERSISTED optimistic turn that the
	// server never recorded (the request dropped before egress or before any token). Two cases:
	//   - cache HIT: we painted a pre-vetted cached answer client-side.
	//   - cache MISS: no cached answer, but the user's typed message + the blank assistant are still
	//     on screen and the turn is retryable.
	// In BOTH cases, while set for the open conversation:
	//   - the generation-state effect must treat the turn as FINISHED, not active. The optimistic
	//     assistant carries no terminal update, so without this it reads as "still generating" —
	//     re-arming the spinner forever AND registering a background generation whose poller fires
	//     an isTerminal reconcile (the server has no such turn) that
	//   - the reconcile effect must NOT honour: syncing `messages` to the empty server snapshot would
	//     WIPE the optimistic turn (the answer on a HIT; on a MISS, the user's own message — so they
	//     lose what they typed along with seeing the error). This veto preserves it so they can retry.
	// Cleared on a fresh writeMessage (a resend supersedes it), on conversation change / remount, and
	// by a MAX_TRACK_DURATION_MS timer (see setCacheFallback): if the request actually
	// DID reach the server but we never saw its egress, the veto must eventually release so the real
	// persisted turn can reconcile in, instead of the optimistic-only turn being protected forever.
	// The painted answer is transient (gone on reload) — correct, since nothing was ever persisted.
	// Re-read this conversation from the server, EXCEPT while a "forget everything" wipe is on screen.
	//
	// The wipe deletes the conversation being viewed, so every refresh after it is guaranteed to 404,
	// and conversation/[id]/+page.ts turns a 404 into a redirect to the chat entry. That redirect
	// crosses route trees here, so it is a real document load: the wipe's confirmation panel — the
	// honest list of what was cleared — is destroyed
	// before it has been read, and the modal comes back armed at "Forget everything?" as though the
	// delete never ran (CUR-1642). The trigger is a turn still streaming when the visitor hits
	// the control: its post-turn resync below fires seconds later against a row that is deliberately
	// gone.
	//
	// Skipping is safe precisely because the row is gone on purpose. There is nothing to reconcile to,
	// and `onWipeDismissed` navigates away with `invalidateAll` the moment the panel is dismissed, so
	// no stale snapshot survives the modal.
	async function resyncConversation(): Promise<void> {
		if (get(wipeInProgress)) return;
		return safeInvalidate(UrlDependency.Conversation);
	}

	// Set when the page is unloading (beforeNavigate's "leave", or pagehide), so a turn torn down by a
	// reload keeps its pending-turn note (CUR-1893).
	let leavingPage = false;

	let cacheFallbackConvId = $state<string | null>(null);
	let cacheFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	// Arm/replace the unpersisted-turn veto for `id`, plus its expiry. On expiry, drop the veto and (if
	// still viewing that conversation) reconcile, so a turn that reached the server surfaces; if nothing
	// was persisted the reconcile is a harmless no-op.
	const setCacheFallback = (id: string) => {
		cacheFallbackConvId = id;
		if (cacheFallbackTimer) clearTimeout(cacheFallbackTimer);
		cacheFallbackTimer = setTimeout(() => {
			cacheFallbackTimer = undefined;
			if (cacheFallbackConvId !== id) return; // superseded by a resend / another conversation
			cacheFallbackConvId = null;
			if (browser && page.params.id === id) {
				void resyncConversation();
			}
		}, MAX_TRACK_DURATION_MS);
	};
	const clearCacheFallback = () => {
		cacheFallbackConvId = null;
		if (cacheFallbackTimer) {
			clearTimeout(cacheFallbackTimer);
			cacheFallbackTimer = undefined;
		}
	};
	// Don't leak the veto timer past unmount (leaving the [id] route entirely).
	onDestroy(() => {
		if (cacheFallbackTimer) clearTimeout(cacheFallbackTimer);
	});

	let files: File[] = $state([]);

	function createMessagesPath<T>(messages: TreeNode<T>[], msgId?: TreeId): TreeNode<T>[] {
		if (initialRun) {
			if (!msgId && page.url.searchParams.get("leafId")) {
				msgId = page.url.searchParams.get("leafId") as string;
				page.url.searchParams.delete("leafId");
			}
			initialRun = false;
		}

		const msg = messages.find((msg) => msg.id === msgId) ?? messages.at(-1);
		if (!msg) return [];
		// ancestor path
		const { ancestors } = msg;
		const path = [];
		if (ancestors?.length) {
			for (const ancestorId of ancestors) {
				const ancestor = messages.find((msg) => msg.id === ancestorId);
				if (ancestor) {
					path.push(ancestor);
				}
			}
		}

		// push the node itself in the middle
		path.push(msg);

		// children path
		let childrenIds = msg.children;
		while (childrenIds?.length) {
			let lastChildId = childrenIds.at(-1);
			const lastChild = messages.find((msg) => msg.id === lastChildId);
			if (lastChild) {
				path.push(lastChild);
			}
			childrenIds = lastChild?.children;
		}

		return path;
	}

	function createMessagesAlternatives<T>(messages: TreeNode<T>[]): TreeId[][] {
		const alternatives = [];
		for (const message of messages) {
			if (message.children?.length) {
				alternatives.push(message.children);
			}
		}
		return alternatives;
	}

	// this function is used to send new message to the backends
	async function writeMessage({
		prompt,
		messageId = messagesPath.at(-1)?.id ?? undefined,
		isRetry = false,
		attach = false,
		resendFiles,
		autoRoute,
	}: {
		prompt?: string;
		messageId?: string;
		isRetry?: boolean;
		/** Re-attach this agent answer to the task it started, rewriting it in place (CUR-993). */
		attach?: boolean;
		/** The files of a question being sent again (CUR-2803), in place of the composer's. */
		resendFiles?: Message["files"];
		/** Auto's choice, read before any await: the composer drops it once its draft clears (CUR-3944). */
		autoRoute?: AutoRouteNote;
	}): Promise<void> {
		// A new turn silences the last answer's read-aloud rather than talking over the next one (CUR-2299).
		stopPlayback();
		// Time-to-first-token watchdog state (see where it's armed, below). Declared
		// at function scope so the finally can always dispose it.
		let watchdogHandle: { rearm: () => void; dispose: () => void } | undefined;
		let firstContentSeen = false;
		// The message the server writes first for this turn (the new question, or the answer a retry
		// rewrites). Hoisted so the finally can tell whether the server's copy holds the turn (CUR-3018).
		let turnAnchorId: Message["id"] | undefined;
		let watchdogTimedOut = false;
		// Set when the watchdog fires AFTER content had already streamed — see
		// classifyWatchdogFire's doc comment for the failure mode this catches (a connection that
		// dies mid-turn, after the server has already started, or finished, answering). (CUR-708)
		let staleConnectionDetected = false;
		// An attach's final answer arrived and was not an interrupted one. (CUR-3875)
		let cleanFinalSeen = false;
		// The request was refused or failed in a way another attempt would repeat. (CUR-3875)
		let requestRefused = false;
		// For an attach, whether it ends by trying again rather than by any failure path. Decided
		// once, the first time a path asks, since every path that asks runs after the stream has ended. (CUR-3875)
		let reattachDecision: boolean | undefined;
		let reattachDeadline = 0;
		// A new turn whose agent run outlasted the request: the server handed the run off to this page
		// (handedOffAgentRun), which follows it the way an attach does. Decided in the finally.
		let handedOff = false;
		// The answer a new turn writes, for that decision; an attach has its own copy above.
		let turnAnswer: Message | undefined;
		const attachConvId = convId;
		const willReattach = () =>
			(reattachDecision ??=
				(attach || handedOff) &&
				!$isAborted &&
				!cleanFinalSeen &&
				!requestRefused &&
				stopRequestedFor !== attachConvId &&
				page.params.id === attachConvId &&
				Date.now() < reattachDeadline);
		// Chat-health telemetry, emitted exactly once in the finally. The generation stream
		// returns HTTP 200 even when a turn fails mid-flight (see Tier0 in-stream Status/Error),
		// so Vercel's error rate is blind to it — these client events are the only place
		// generation success/latency/failure-reason is observable. turnStartedAt anchors both
		// TTFT (first content byte) and total latency (final answer).
		const turnStartedAt = Date.now();
		// A held refusal from the last send stays up until the person sends again (CUR-1896).
		if (get(errorHeld)) {
			error.set(undefined);
			errorHeld.set(false);
		}
		let firstTokenAt: number | undefined;
		let finalAnswerAt: number | undefined;
		// Which model the turn asked for and which one the router says served it, so TTFT can be
		// split by model (CUR-3967). Turn-scoped here because messageToWriteTo lives inside the try.
		let modelRequested: string | undefined;
		let modelServed: string | undefined;
		// Per-turn error flag for the outcome telemetry. Deliberately NOT the shared $error
		// store: that store is module-level and isn't reset at turn start, so keying on it
		// would misclassify a successful retry after an error. This one is fresh every turn.
		let turnErrored = false;
		// Set when the generation POST still returns a 5xx after connectWithRetry has exhausted its
		// cold-start retries. Like the TTFT-watchdog path, we then route the turn into applyEarlyStreamFailure
		// to fail it NOW (visible, retryable, or a cached answer) instead of a phantom "working…" until the
		// 2-min stale eviction.
		let requestFailedEarly = false;
		// Set when the early failure was specifically a 503 capacity shed (the server's admission gate
		// retried it pre-accept and still couldn't admit). Steers applyEarlyStreamFailure's cache-MISS
		// copy to the calm "busy" message instead of "connection lost" - it isn't the user's network.
		let capacityShed = false;
		// Assigned inside the try once the target message exists; called from the
		// after-loop, the no-iterator early return, AND the catch — hence function
		// scope rather than a try-local const.
		let applyEarlyStreamFailure: (() => Promise<void>) | undefined;
		// Same reason as applyEarlyStreamFailure above: assigned inside the try once
		// messageToWriteTo exists, called from both the after-loop path and the catch
		// (CUR-708's stall-recovery branch — see classifyWatchdogFire).
		let handleStalledConnection: (() => void) | undefined;
		// Set for an attach once its copy exists; called after every update and from the finally. (CUR-3875)
		let publishReplay: ((mode: "streaming" | "final" | "gave-up") => void) | undefined;
		// Same again, for the visitor's own connection failing after content streamed (CUR-2805).
		let handleLateConnectionLoss: (() => void) | undefined;
		// This turn's claim on localTurnSyncHold (see localTurnSyncHoldOwner).
		const turnHoldToken = Symbol("turn");
		// Set once the turn's pending-turn note is written (CUR-1893); run from the finally.
		let clearOwnPendingTurn: (() => void) | undefined;
		try {
			stopRequestedFor = null;
			$isAborted = false;
			$loading = true;
			// An attach rewrites an answer already on screen, so there is no new answer to stand in for:
			// `pending` would add an empty "Working on it…" bubble under it until the replay's first token
			// (CUR-3875). The answer itself reads as running, which keeps `$loading` up.
			pending = !attach;
			// A fresh attempt (incl. a resend) supersedes any prior unpersisted-turn veto
			// for this conversation; re-enable the normal server reconcile.
			clearCacheFallback();
			writeMessageInFlight = true;
			retryTargetMissing = false;
			// Hold the data-driven resync for the whole turn (released by the finally only after the
			// post-turn refresh is observed applied — see the declaration for why observed, not resolved).
			localTurnSyncHoldOwner = turnHoldToken;
			localTurnSyncHold = true;
			// Create the controller before any await: a Stop click during file
			// encoding or MCP hydration must abort THIS request, not whichever
			// stale controller a previous generation left behind.
			messageUpdatesAbortController = new AbortController();
			activeGenerationId = v4();
			// A send from a new chat was encoded on the landing page, so this resolves without a read and the
			// question replaces that page's bubble with nothing between them (CUR-3506).
			const base64Files = resendFiles ?? (await encodeMessageFiles(files ?? []));

			let messageToWriteToId: Message["id"] | undefined = undefined;
			// An attach's off-screen copy of the answer; see the attach branch below. (CUR-3875)
			let replay: Message | undefined;
			// used for building the prompt, subtree of the conversation that goes from the latest message to the root
			// Defaults to messageId: correct for the edit-a-user-message retry, where messageId
			// already names the user turn. Overridden below for a plain assistant regenerate,
			// where messageId names the assistant answer instead and the user turn is its parent.
			let userMessageId: Message["id"] | undefined = messageId;
			// The user message this turn adds, when it adds one. Sent with messageToWriteToId so the server
			// builds its copy of the turn with the same ids; see newMessageIds in requestSchema (CUR-2098).
			let newUserId: Message["id"] | undefined = undefined;

			if (attach && messageId) {
				// The server empties this same message and rebuilds it from the task's replayed events. The
				// page streams those into a copy and keeps showing the answer until the copy catches up
				// (CUR-3875, see reattachView), minus whatever ended the last attempt, so it reads as running.
				const target = messages.find((message) => message.id === messageId);
				if (target) {
					reattachDeadline = agentRunReattachDeadline(target, Date.now(), page.data.agentRunHandoffEnabled === true);
					Object.assign(target, {
						updates: (target.updates ?? []).filter((update) => !endsTheTurn(update)),
						interrupted: false,
					});
					replay = { ...$state.snapshot(target), content: "", updates: [] } as Message;
					messageToWriteToId = target.id;
					userMessageId = target.ancestors?.at(-1);
				}
			} else if (isRetry && messageId) {
				// two cases, if we're retrying a user message with a newPrompt set,
				// it means we're editing a user message
				// if we're retrying on an assistant message, newPrompt cannot be set
				// it means we're retrying the last assistant message for a new answer

				const messageToRetry = messages.find((message) => message.id === messageId);

				if (!messageToRetry) {
					$error = "Message not found";
				}

				if (messageToRetry?.from === "user" && prompt) {
					// add a sibling to this message from the user, with the alternative prompt
					// add a children to that sibling, where we can write to
					const newUserMessageId = addSibling(
						{
							messages,
							rootMessageId,
						},
						{
							from: "user",
							content: prompt,
							files: messageToRetry.files,
						},
						messageId
					);
					newUserId = newUserMessageId;
					messageToWriteToId = addChildren(
						{
							messages,
							rootMessageId,
						},
						{ from: "assistant", content: "" },
						newUserMessageId
					);
				} else if (messageToRetry?.from === "assistant") {
					// we're retrying an assistant message, to generate a new answer
					// just add a sibling to the assistant answer where we can write to
					messageToWriteToId = addSibling(
						{
							messages,
							rootMessageId,
						},
						{ from: "assistant", content: "" },
						messageId
					);
					// messageId is the assistant answer's own id here, not the question
					// that produced it — the question is its parent in the tree.
					userMessageId = messageToRetry.ancestors?.at(-1);
				}
			} else {
				// just a normal linear conversation, so we add the user message
				// and the blank assistant message back to back
				const newUserMessageId = addChildren(
					{
						messages,
						rootMessageId,
					},
					{
						from: "user",
						content: prompt ?? "",
						files: base64Files,
					},
					messageId
				);
				newUserId = newUserMessageId;

				if (!rootMessageId) {
					rootMessageId = newUserMessageId;
				}

				messageToWriteToId = addChildren(
					{
						messages,
						rootMessageId,
					},
					{
						from: "assistant",
						content: "",
					},
					newUserMessageId
				);
			}

			const userMessage = messages.find((message) => message.id === userMessageId);
			const shownMessage = messages.find((message) => message.id === messageToWriteToId);
			if (!shownMessage) {
				throw new Error("Message to write to not found");
			}
			const messageToWriteTo = replay ?? shownMessage;
			if (!attach) turnAnswer = shownMessage;
			// Copy the attach's replay onto the screen once reattachView allows it. (CUR-3875)
			if (replay) {
				const copy = replay;
				publishReplay = (mode) => {
					const view = reattachView(shownMessage, copy, mode);
					if (view) Object.assign(shownMessage, { ...copy, ...view });
				};
			}
			// The server stamps the same id on its copy. Set here too so the footer judges this
			// answer against the model it was sent to before the end-of-turn refresh brings that copy back. (CUR-3234)
			if (currentModel) messageToWriteTo.requestedModel = modelRequested = currentModel.id;
			// Say live what Auto does about a slow first word. Auto's second ask shows the note naming
			// both models now, not only after the end-of-turn refresh brings the server's copy back; a first
			// send tells the live log how long Auto will wait, so it can say the model is slow to start. (CUR-4384)
			if (isRetry && autoRoute?.repickedFrom) messageToWriteTo.autoRoute = autoRoute;
			else {
				const autoChoice = isRetry || attach ? undefined : (autoRoute ?? autoRouteFor(prompt));
				if (page.data.autoRepickEnabled === true && autoChoice && messageToWriteToId)
					repickWait.set({
						answerId: messageToWriteToId,
						model: autoChoice.model,
						waitMs: page.data.autoRepickWaitMs?.[autoChoice.model] ?? 20_000,
					});
			}

			// Pin the visible thread to the branch this turn just created. A plain
			// $derived recompute would fall back to messages.at(-1), which is only
			// ever correct when the retried message was already the last turn — see
			// pinnedLeafId's declaration next to messagesPath.
			pinnedLeafId = messageToWriteToId;
			// A reload before the server saves this turn would load a snapshot without it, so
			// leave a note naming the message the server will write first. The finally clears it. (CUR-1893)
			const turnConvId = convId;
			const turnMessageId = newUserId ?? messageToWriteToId;
			turnAnchorId = turnMessageId;
			if (turnMessageId) recordPendingTurn(turnConvId, turnMessageId);
			// Not while the page is going away: a reload aborts this request and runs the finally, and the
			// note is exactly what that reload needs.
			clearOwnPendingTurn = () => {
				if (!leavingPage) clearPendingTurn(turnConvId);
			};

			// Open-web search now runs SERVER-side (community-first: after RAG) — no pre-POST classify/search
			// round-trip here. The server streams a WebSearch update during the request, which the loop below
			// stamps onto messageToWriteTo.webSearch live (see MessageUpdateType.WebSearch). The user's choice
			// rides up as webSearchMode in the POST body.

			// Smooth stream for everyone; there is no Raw choice, so a previously saved value does not apply.
			const streamingMode = "smooth" as const;

			// Mark the moment real output starts (first token, or a final answer that
			// arrives without prior streaming). It does not disarm firstTokenWatchdog:
			// the loop's own re-arm call below runs unconditionally on every
			// inbound update (not just pre-content), so the watchdog stays a pure TOTAL-silence
			// detector for the whole turn, in both regimes — see classifyWatchdogFire.
			const markFirstContent = () => {
				firstContentSeen = true;
				// First rendered content byte — TTFT anchor for response_received.
				firstTokenAt ??= Date.now();
			};

			// EARLY-failure path: the watchdog fired before anything rendered — the
			// connection stalled at setup, or the stream died before the first token
			// (a stalled network). Without this the for-await below would await
			// forever and the "…" spinner would never clear.
			//
			// Live-first resilience: on failure (only) look up a pre-vetted starter
			// answer. On a HIT render the real warmed model output — same content
			// surface as live (answer text + cited sources + asOf), no "cached" badge,
			// so nothing misleads. On a MISS fall back to a retryable message; since no
			// tokens streamed, the turn is safe to resend.
			applyEarlyStreamFailure = async () => {
				// An attach that will try again is not a failed turn. (CUR-3875)
				if (willReattach()) return;
				// CUR-1660 — see the note below this assignment for why the early-failure regime needs
				// this too, and why it is free when the request genuinely never reached the server.
				addBackgroundGeneration({ id: convId, startedAt: Date.now() });
				const cached = await getCachedAnswer(prompt ?? "");
				if (cached) {
					messageToWriteTo.content = cached.answer;
					// Transient honesty marker (client-render-only, never persisted): this turn
					// was served from a pre-vetted starter answer because the live request never
					// reached the server. ChatMessage renders an honesty chip off it.
					messageToWriteTo.servedFromCache = true;
					if (cached.sources.length > 0) {
						messageToWriteTo.webSearch = {
							query: prompt ?? "",
							sources: cached.sources,
							asOf: cached.asOf ?? "",
						};
					}
					// Mark the conversation as carrying a client-only cache answer so the
					// generation-state effect treats the turn as finished (no spinner, no
					// background-generation registration) and the reconcile effect refuses
					// to overwrite it with the empty server snapshot (see flag declaration).
					setCacheFallback(convId);
					return;
				}
				// Cache MISS: no pre-vetted answer to paint, but the user's typed message and the
				// blank assistant are still on screen. Veto the reconcile here too — without it the
				// finally block's invalidate would sync `messages` to the empty server snapshot and
				// WIPE the user's own message along with showing the error. With the veto, the turn is
				// preserved and retryable; the timer releases it later in case the request did reach
				// the server. Show the connection-lost error so the failure is visible.
				setCacheFallback(convId);
				// End the turn in the transcript, the way the server ends one it failed. Without a
				// terminal update the empty assistant still derives as "running", so its live line went on
				// counting "Working on it…" after the toast said the send had failed. The error status makes
				// it ChatMessage's retryable error notice (role="alert"), which replaces the toast here, and
				// a server-side answer the poller finds later still replaces the whole turn. (CUR-2613)
				messageToWriteTo.updates = [
					...(messageToWriteTo.updates ?? []),
					{
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: capacityShed ? ERROR_MESSAGES.atCapacity : ERROR_MESSAGES.connectionLost,
					},
				];
			};

			// This path ALSO has to watch for a server-side completion, like the others (CUR-1660). The
			// split in classifyWatchdogFire reads "nothing rendered, so the request never reached the
			// server", which is false on a deployment where output screening is the first-token gate:
			// there an ordinary turn renders nothing until it ENDS and `firstContentSeen` is false for
			// the whole of it.
			//
			// The server streams a 39-byte keepalive every 2s; when those stop, this client aborts 8.0s
			// later, and the server finishes and persists the real answer anyway (it treats client
			// silence as no reason to stop). Without the registration the page sits on "<model> is
			// working…" while a reload renders the same answer in under two seconds.
			//
			// Registering here costs nothing when the request really never landed: the entry never goes
			// terminal, the snapshot the poller's invalidate delivers stays empty, `snapshotHasAnswer`
			// is false, the cache-fallback veto still holds, and the existing eviction timer clears it.
			// The registration itself lives at the top of applyEarlyStreamFailure above, so all four
			// of its call sites are covered by one line and a fifth cannot forget it.

			// CUR-708 STALL-recovery path: the watchdog fired AFTER content had already streamed (see
			// classifyWatchdogFire). Unlike the early-failure regime above, the connection was
			// genuinely alive at some point — the server may already have finished and persisted a
			// full, correct answer that this tab's own dead connection just never delivered. So this
			// does NOT show an error over the partial content, and it deliberately does NOT call
			// stop-generating: the server-side turn may still be legitimately in progress and
			// stop-generating would clamp/truncate a real answer the client merely lost the line to.
			//
			// Instead: mark the in-progress message locally interrupted — mirroring stopGeneration's
			// own trick — so the reconcile effect below doesn't mistake this tab's own stale local
			// snapshot for a still-active stream and re-arm $loading once writeMessageInFlight drops.
			// Then hand the conversation to the background-generation poller, which already exists to
			// watch a generation this tab isn't actively streaming and pull in the real terminal
			// answer over its own SSE channel — a channel unrelated to (and thus not a victim of)
			// whatever killed this specific fetch's connection.
			handleStalledConnection = () => {
				if (willReattach()) return;
				messageToWriteTo.interrupted = true;
				addBackgroundGeneration({ id: convId, startedAt: Date.now() });
			};

			// The fetch itself failed after content streamed — the visitor went offline, or a
			// proxy cut the line. The partial answer stays, the turn ends with a retryable notice in the
			// transcript instead of a toast of the browser's own "network error", and the poller is told
			// to watch, because the server keeps generating and a finished answer it finds replaces the
			// whole turn once the visitor is back online. (CUR-2805)
			handleLateConnectionLoss = () => {
				if (willReattach()) return;
				// Veto the reconcile, as the early path does: the reload that follows this turn either fails
				// offline or returns a snapshot without this turn's answer, and either way must not wipe it.
				setCacheFallback(convId);
				messageToWriteTo.updates = [
					...(messageToWriteTo.updates ?? []),
					{
						type: MessageUpdateType.Status,
						status: MessageUpdateStatus.Error,
						message: ERROR_MESSAGES.connectionDroppedMidAnswer,
					},
				];
				addBackgroundGeneration({ id: convId, startedAt: Date.now() });
			};

			// Time-to-first-token watchdog (cause-agnostic). fetch() has no timeout, and
			// a stream can stall or die before the first token with neither a token nor
			// an error — so the for-await below can hang the spinner indefinitely. If
			// nothing arrives within the window, abort (unsticking any hung read) and
			// take the EARLY-failure path.
			//
			// The window is re-armed on every inbound update (below, for the WHOLE turn as of
			// CUR-708 — not just before the first token), so this is purely a DEAD-CONNECTION
			// detector: it fires only on TOTAL silence. A legitimately slow turn — e.g. a grounded
			// answer doing >8s of retrieval before the first token, or an agent turn computing
			// silently between narration steps — keeps re-arming and is never false-tripped; the
			// agent relay specifically pulses a keepalive at least every 4s for exactly this reason
			// (see endpointAgent.ts's HEARTBEAT_MS). The dead-connection regime it guards against
			// produces no updates at all, so there is nothing to re-arm it with — in EITHER regime,
			// which is why the fire handler no longer bails out once content has streamed (see
			// classifyWatchdogFire for what changed and why).
			const FIRST_TOKEN_TIMEOUT_MS = 8000;
			// A plain setTimeout is not enough here — Chrome throttles timers in a
			// backgrounded tab (ordinary 1s alignment at first, then "intensive throttling" coalescing
			// them to roughly once a minute once a page has accumulated enough hidden time), and a long
			// agent turn is exactly the case someone tabs away during. armSilenceWatchdog adds a
			// visibilitychange fallback that re-checks wall-clock elapsed time the instant the tab is
			// looked at again, instead of trusting the timer to have fired on schedule — see its own doc
			// comment in generationState.ts. (CUR-708)
			watchdogHandle = armSilenceWatchdog({
				timeoutMs: FIRST_TOKEN_TIMEOUT_MS,
				onFire: () => {
					const outcome = classifyWatchdogFire({ firstContentSeen, isAborted: $isAborted });
					if (outcome === "ignore") return;
					if (outcome === "early-failure") watchdogTimedOut = true;
					else staleConnectionDetected = true;
					messageUpdatesAbortController.abort();
				},
			});
			const armFirstTokenWatchdog = () => watchdogHandle?.rearm();

			const handleFetchError = (err: unknown) => {
				// A 404 on a plain Retry means the server never stored this turn, which is what a
				// send that failed before the question was saved leaves behind. onRetry sends the question
				// again as a new turn, so this is not an error to show. (CUR-2803)
				if (isRetry && !prompt && !attach && err instanceof GenerationRequestError && err.status === 404) {
					retryTargetMissing = true;
					return undefined;
				}
				// W2 idempotency: a 409 means this generationId is already running/finished server-side (a
				// duplicate POST from a network auto-retry). Don't toast and don't re-submit — attach to the
				// existing run by registering it as a background generation (the SSE poller delivers its
				// completion) and refresh the conversation so the in-flight/finished turn surfaces.
				if (err instanceof GenerationConflictError) {
					addBackgroundGeneration({ id: convId, startedAt: Date.now() });
					void resyncConversation();
					return undefined;
				}
				// A user abort rejects the fetch; that is not an error worth a toast
				if (!$isAborted && !(err instanceof DOMException && err.name === "AbortError")) {
					// A pre-stream 5xx (killed/cold serverless invocation) may have left an orphaned
					// in-flight claim server-side with no terminal write. Flag it so the loop below auto-
					// retries (fast, cold-start recovery) and, once the budget is spent, fails the turn via
					// applyEarlyStreamFailure — a cached answer or a retryable connection-lost error — rather
					// than a phantom "working…" until the 2-min stale eviction. Its own message replaces the
					// raw status text, so don't also toast.
					if (err instanceof GenerationRequestError && err.status >= 500) {
						requestFailedEarly = true;
						// A 503 here is the admission gate's capacity shed, already retried to exhaustion by the vet.
						// Remember that so the terminal copy is the calm "busy" message, not "connection lost".
						if (err.status === 503) capacityShed = true;
						return undefined;
					}
					requestRefused = true;
					const reason = err instanceof Error ? err.message : String(err);
					// Any 4xx refusal before streaming fails the turn, and the optimistic message is rolled
					// back on resync because the server never saved it — so without this the user's typed
					// text is silently eaten. Restore it to the composer (reactive via the pendingChatInput
					// $effect) so a refusal never loses what they wrote. Rate-limit / cap 429s were the
					// first case of this; CUR-1896 found 400 "Message too long." and 413/415 doing the same.
					const refused = err instanceof GenerationRequestError && err.status < 500;
					const restore = refused || (err instanceof Error && isRateLimitMessage(err.message));
					// A refused EDIT goes back into its own edit box with the reason beside it.
					// In the main composer, Send made a new message instead of a new version of this one. (CUR-2825)
					const edited =
						isRetry && prompt && messageId
							? messages.find((m) => m.id === messageId && m.from === "user")
							: undefined;
					if (restore && edited && prompt) {
						refusedEdit.set({ id: edited.id, text: prompt, reason });
					} else {
						error.set(reason);
						if (restore) pendingChatInput.set(prompt);
					}
					// The server said how long our own limit's window has left, so Send is held and
					// counted down instead of leaving a press that only extends the wait: the composer's, and a
					// refused edit's own box (CUR-3410). (CUR-3216)
					if (refused && err.retryAfterSeconds) {
						sendHeldUntil.set(Date.now() + err.retryAfterSeconds * 1000);
					}
					if (refused && !edited) {
						errorHeld.set(true);
						// The attachment IS the reason for these; leaving it on the composer makes a resend
						// fail the same way. 422 is the abuse-match refusal (CUR-3086).
						if (err.status === 413 || err.status === 415 || err.status === 422) files = [];
					}
				}
				return undefined;
			};

				// Cold-start recovery lives in ONE place now: connectWithRetry retries BOTH shapes it can
				// take — a connect drop (flaky wifi) and a fast 5xx (cold/killed serverless invocation) — under
				// the same backoff+jitter, while the live log keeps showing the existing "working…". A retry
				// advances the idempotency key ONLY after a 5xx (dead claim); a connect drop reuses it so W2
				// idempotency attaches to a possibly-live run instead of double-firing. If every attempt fails,
				// fetchMessageUpdates throws -> handleFetchError sets requestFailedEarly -> we fail the turn via
				// applyEarlyStreamFailure below (a cached answer or a retryable error, never a phantom "working").
				requestFailedEarly = false;
				const messageUpdatesIterator = await fetchMessageUpdates(
					convId,
					{
						base,
						inputs: prompt,
						messageId,
						isRetry,
						agentAttach: attach || undefined,
						generationId: activeGenerationId,
						newMessageIds: attach ? undefined : { user: newUserId, assistant: messageToWriteToId },
						files: attach ? undefined : isRetry ? userMessage?.files : base64Files,
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						streamingMode,
						webSearchMode: get(webSearchMode),
						// speakAll kept for deploy-skew (old server); speakMode is the authoritative tri-state a
						// new server reads so it can honor "off" (which speakAll alone collapses into "auto").
						speakAll: get(speakMode) === "always",
						speakMode: get(speakMode),
						// The stored preference outlives a sign-out, and the server refuses a guest's "on" (CUR-4400),
						// so it is sent only to an account the composer offers agent mode to.
						agentMode: page.data.agentEnabled ? get(agentMode) : "off",
						// A retry carries Auto's note only when it is Auto picking again (CUR-4384).
						autoRoute:
							attach || (isRetry && !autoRoute?.repickedFrom)
								? undefined
								: (autoRoute ?? autoRouteFor(prompt)),
						advanceGenerationId: () => (activeGenerationId = v4()),
						// Pre-stream events (heartbeats while the server's chain runs) are consumed by the
						// vet inside fetchMessageUpdates and never reach the loop below — re-arm the
						// silence-based watchdog here so a legitimately slow chain isn't a false abort.
						onPrestreamEvent: () => {
							if (!firstContentSeen) armFirstTokenWatchdog();
							// Stop was pressed on the landing page before this page took over. The
							// first event means the server has the question, so stopping now keeps it. (CUR-2971)
							if (takeStopOnArrival(convId)) void stopGeneration();
						},
					},
					messageUpdatesAbortController.signal,
				).catch(handleFetchError);
			if (messageUpdatesIterator === undefined) {
				// No stream. Take the EARLY-failure path if the TTFT watchdog aborted a setup stall OR the
				// connect layer exhausted its retries on a 5xx; the finally resets the spinner either way.
				if (watchdogTimedOut || requestFailedEarly) await applyEarlyStreamFailure?.();
				return;
			}

			// The same landing-page Stop, for a response that sent no pre-stream event. (CUR-2971)
			if (takeStopOnArrival(convId)) void stopGeneration();

			files = [];
			let buffer = "";
			// Initialize lastUpdateTime outside the loop to persist between updates
			let lastUpdateTime = new Date();
			let frameFlushScheduled = false;

			const flushBuffer = (currentTime: Date) => {
				if (buffer.length === 0) return;
				// Stop reports the reply's length on screen and the server keeps exactly that much, so a
				// frame scheduled before Stop must not add the tokens it was holding.
				if ($isAborted) {
					buffer = "";
					return;
				}
				messageToWriteTo.content += buffer;
				buffer = "";
				lastUpdateTime = currentTime;
				publishReplay?.("streaming");
			};
			commitHeldTokens = () => flushBuffer(new Date());

			const scheduleFrameFlush = () => {
				if (frameFlushScheduled) return;
				frameFlushScheduled = true;
				const flush = () => {
					frameFlushScheduled = false;
					flushBuffer(new Date());
				};
				if (typeof requestAnimationFrame === "function") {
					requestAnimationFrame(flush);
				} else {
					setTimeout(flush, 0);
				}
			};

			for await (const update of messageUpdatesIterator) {
				if ($isAborted) {
					messageUpdatesAbortController.abort();
					return;
				}

				// Any inbound update proves the connection is alive: re-arm the watchdog so a
				// legitimately slow turn (long retrieval before the first token, or an agent
				// computing silently between narration steps) isn't aborted as a false positive.
				// The watchdog is armed for the WHOLE turn, so a connection that dies mid-turn is still caught (CUR-708).
				armFirstTokenWatchdog();

				// Remove null characters added due to remote keylogging prevention
				// See server code for more details
				if (update.type === MessageUpdateType.Stream) {
					update.token = update.token.replaceAll("\0", "");
				}

				const isKeepAlive =
					update.type === MessageUpdateType.Status &&
					update.status === MessageUpdateStatus.KeepAlive;

				// "speak every answer" synthesis marker: the answer text is on screen and we're now in the
				// ZeroGPU TTS round-trip. Flag it so the trace footer reads "Generating audio…" rather than
				// showing a silent pause. Cleared in the finally when the turn ends.
				//
				// Also stand the watchdog down here, same as the Safety branch below. A read-aloud
				// turn (auto's explicit-ask path, or "always") deliberately suppresses every Stream token AND
				// the model's own FinalAnswer for its whole duration (textGeneration/index.ts's `willCompose`
				// takeover) — the ONLY client-visible signal before the composed answer + audio land is this
				// SPEAK_STATUS marker. Without this, firstContentSeen stays false for the entire generation +
				// TTS round-trip (a ZeroGPU cold start can run 30-60s), so ANY connection hiccup in that window
				// — the exact window most likely to have one — has classifyWatchdogFire call it "early-failure"
				// (never started) instead of "stall-recovery" (genuinely alive, hand off to the background-
					// generation poller). A mislabeled turn would let a real, server-side-successful TTS attempt
				// (the Space woke, returned a real clip, the client fetched and played it) still surface as
				// "The connection dropped before a reply arrived" instead of quietly
				// recovering — from the user's chair that reads as "nothing was even attempted." (CUR-1076)
				if (update.type === MessageUpdateType.Status && update.message === SPEAK_STATUS) {
					synthesizingAudioFor.set(messageToWriteTo.id);
					markFirstContent();
				}

				// Live phase marker (screening/searching/thinking/…): reflect the turn's current phase so the
				// request log shows what's actually happening, not a generic "working…". Like SPEAK_STATUS,
				// intercepted BEFORE the KeepAlive filter below so it's never kept in updates[]; cleared in the
				// finally when the turn ends.
				if (update.type === MessageUpdateType.Status && update.message?.startsWith(PHASE_PREFIX)) {
					currentPhase.set(update.message.slice(PHASE_PREFIX.length));
				}

				if (!isKeepAlive) {
					if (update.type === MessageUpdateType.Stream) {
						const existingUpdates = messageToWriteTo.updates ?? [];
						const lastUpdate = existingUpdates.at(-1);
						if (lastUpdate?.type === MessageUpdateType.Stream) {
							// Create fresh objects/arrays so the UI reacts to merged tokens
							const merged = {
								...lastUpdate,
								token: (lastUpdate.token ?? "") + (update.token ?? ""),
							};
							messageToWriteTo.updates = [...existingUpdates.slice(0, -1), merged];
						} else {
							messageToWriteTo.updates = [...existingUpdates, update];
						}
					} else {
						messageToWriteTo.updates = [...(messageToWriteTo.updates ?? []), update];
					}
				}
				const currentTime = new Date();

				// If we receive a non-stream update (e.g. tool/status/final answer),
				// flush any buffered stream tokens so the UI doesn't appear to cut
				// mid-sentence while tools are running or the final answer arrives.
				if (update.type !== MessageUpdateType.Stream && buffer.length > 0) {
					flushBuffer(currentTime);
				}

				if (update.type === MessageUpdateType.Stream) {
					buffer += update.token;
					if (streamingMode === "smooth") {
						// Coalesce UI updates to animation frames for smooth mode.
						scheduleFrameFlush();
					} else if (
						currentTime.getTime() - lastUpdateTime.getTime() >
						updateDebouncer.maxUpdateTime
					) {
						flushBuffer(currentTime);
					}
					if (pending) {
						streamStart();
					}
					pending = false;
					markFirstContent();
				} else if (update.type === MessageUpdateType.FinalAnswer) {
					// Real output has arrived (possibly as a single final answer with no
					// prior streaming) — stand the watchdog down.
					markFirstContent();
					// Mirror server-side merge behavior so the UI reflects the
					// final text once tools complete, while preserving any
					// pre‑tool streamed content when appropriate.
					const finalText = update.text ?? "";
					const isInterrupted = update.interrupted === true;
					// Tools/MCP removed (B1-lite strip) — no tool updates are ever produced.
					const hadTools = false;

					if (isInterrupted) {
						if (!messageToWriteTo.content) {
							// We never streamed anything; fall back to finalText.
							messageToWriteTo.content = finalText;
						} else if (finalText && messageToWriteTo.content.startsWith(finalText)) {
							// The server may have clamped the persisted text back to a
							// reported stop point (see stop-generating). Adopt it when it
							// is a prefix of what we streamed so this view matches what
							// every other view will load; otherwise keep our streamed
							// content (continue flows receive only the post-prefix text).
							messageToWriteTo.content = finalText;
						}
					} else if (hadTools) {
						const existing = messageToWriteTo.content;
						const trimmedExistingSuffix = existing.replace(/\s+$/, "");
						const trimmedFinalPrefix = finalText.replace(/^\s+/, "");
						const alreadyStreamed =
							finalText &&
							(existing.endsWith(finalText) ||
								(trimmedFinalPrefix.length > 0 &&
									trimmedExistingSuffix.endsWith(trimmedFinalPrefix)));

						if (existing && existing.length > 0) {
							if (alreadyStreamed) {
								// A. Already streamed the same final text; keep as-is.
								messageToWriteTo.content = existing;
							} else if (
								finalText &&
								(finalText.startsWith(existing) ||
									(trimmedExistingSuffix.length > 0 &&
										trimmedFinalPrefix.startsWith(trimmedExistingSuffix)))
							) {
								// B. Final text already includes streamed prefix; use it verbatim.
								messageToWriteTo.content = finalText;
							} else {
								// C. Merge with a paragraph break for readability.
								const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(finalText ?? "");
								messageToWriteTo.content = existing + (needsGap ? "\n\n" : "") + finalText;
							}
						} else {
							messageToWriteTo.content = finalText;
						}
					} else {
						// No tools: final answer replaces streamed content so
						// the provider's final text is authoritative.
						messageToWriteTo.content = finalText;
					}

					// Accumulate the session footprint's energy estimate from the settled
					// reply text (we have no real token usage; guards on empty content).
					footprint.recordResponse(messageToWriteTo.content);
					// A real final answer settled — record the completion time for latency.
					finalAnswerAt = Date.now();
					if (!isInterrupted) cleanFinalSeen = true;
				} else if (
					update.type === MessageUpdateType.Status &&
					update.status === MessageUpdateStatus.Error
				) {
					// 402 (HuggingChat PRO upsell) removed — our serving has no billing/accounts;
					// a stray 402 now falls through to the generic error below.
					if (
						update.statusCode === 401 &&
						typeof update.message === "string" &&
						/oauth authorization|has been revoked|requested scopes/i.test(update.message)
					) {
						// The stored OAuth token was revoked or no longer matches scopes.
						// Restart the OAuth flow and return to this conversation afterwards.
						const next = encodeURIComponent(`${base}/conversation/${convId}`);
						window.location.assign(`${base}/login?next=${next}`);
					} else {
						// No toast (CUR-1921). The failed turn's bubble renders this same message with its
						// Retry (ChatMessage's error notice, CUR-1748), and a toast on top made a timed-out
						// turn read as two separate failures.
						turnErrored = true;
						// A 429 on the stream is the model's host refusing, so Auto skips it here. (CUR-4043)
						// So is a model that sent nothing before its give-up, and CUR-4629 a 404 or 5xx. (CUR-4098)
						// Never a turn the agent served, which the chosen model never answered. (CUR-4661)
						if (
							failureMarksModelBusy({
								statusCode: update.statusCode,
								modelSilent: update.modelSilent === true,
								route: messageToWriteTo.routerMetadata?.route,
							}) &&
							currentModel
						)
							markBusyHere(currentModel.id);
						// Auto chose this model and it never started, so onMessage asks Auto again. (CUR-4384)
						const sentWith = isRetry || attach ? autoRoute : (autoRoute ?? autoRouteFor(prompt));
						if (
							shouldRepick({
								enabled: page.data.autoRepickEnabled === true,
								autoRoute: sentWith,
								isRetry,
								attach,
								statusCode: update.statusCode,
								modelSilent: update.modelSilent === true,
								contentSeen: firstContentSeen,
							}) &&
							sentWith
						)
							repickFor = { answerId: messageToWriteTo.id, from: sentWith.model };
					}
				} else if (update.type === MessageUpdateType.Title) {
					// Update the sidebar title directly via the store — no side-channel needed.
					// `source` rides along so the rail can say whether a model named this conversation
					// or it fell back to the first five words, which look identical (CUR-1819).
					convsStore.update(convId, { title: update.title, titleSource: update.source });
				} else if (update.type === MessageUpdateType.File) {
					if (
						!update.agentPath ||
						!messageToWriteTo.files?.some((f) => f.value === update.sha && f.agentPath === update.agentPath)
					) {
						messageToWriteTo.files = [
							...(messageToWriteTo.files ?? []),
							{
								type: "hash",
								value: update.sha,
								mime: update.mime,
								name: update.name,
								...(update.agentPath ? { agentPath: update.agentPath } : {}),
							},
						];
					}
				} else if (update.type === MessageUpdateType.RouterMetadata) {
					// Merge non-empty fields, last-non-empty-wins. route/model/provider can arrive in
					// SEPARATE frames (e.g. the agent's done.model correction carries route+model, then a
					// later provider-only finalize frame arrives with model:""). A blind overwrite would let the
					// empty frame clobber a real model, and the badge would fall back to the conversation default
					// (for example showing the default model on an agent turn that ran another). Mirrors the
					// server reducer's merge in streamUpdate.ts by calling the same function, so the live
					// badge keeps `backend` (its "compute:" segment) and `verifyMethod` too (CUR-2135).
					messageToWriteTo.routerMetadata = mergeRouterMetadata(
						messageToWriteTo.routerMetadata,
						update
					);
					modelServed = messageToWriteTo.routerMetadata?.model || modelServed;
				} else if (update.type === MessageUpdateType.AgentStep) {
					// Agent step (Story B): the agent service advanced one execution step. Beat BOTH the
					// Apertus model node and the Hermes agent node — each step IS the sovereign model
					// working, driven by the agent loop, so pulsing both keeps the animation coherent with
					// the provenance badge (which centers on the Apertus node). The step text itself streams
					// in the <think> block; this is the ambient map animation.
					if (browser) {
						window.dispatchEvent(
							new CustomEvent("ap:flash", { detail: { ids: ["apertus", "hermes"] } })
						);
					}
				} else if (update.type === MessageUpdateType.Safety) {
					// A safety decline is a real terminal response (just not a token), so stand
					// the watchdog down — it must not later clobber the decline with a fallback.
					markFirstContent();
					// Safety pre-screen declined this turn before the model ran. Stamp the marker
					// so the answer renders as a safety decline (no Apertus provenance badge) and
					// the live-stack map highlights the safety node. Shape owned by
					// moderationMarker (shared with the server stamp) so the two can't drift.
					messageToWriteTo.moderation = moderationMarker({
						label: update.label,
						score: update.score,
						kind: update.kind,
						ruleLabel: update.ruleLabel,
						unscreened: update.unscreened,
						support: update.support,
					});
				} else if (update.type === MessageUpdateType.OutputSafety) {
					// OUTPUT screening verdict (post-generation). Unlike the input Safety decline, the model
					// DID run — the answer text already streamed (a decline / cleared-prefix). This just stamps
					// outputModeration so the live map lights the safety node + "blocked by — <rule>" and the
					// trace's "Output screen" step is honest now, not only after a reload. Mirrors the server stamp.
					messageToWriteTo.outputModeration = {
						flagged: update.flagged,
						label: update.label,
						score: update.score,
						kind: update.kind,
						screened: update.screened,
						...(update.truncated ? { truncated: true } : {}),
						...(update.ruleLabel ? { ruleLabel: update.ruleLabel } : {}),
						...(update.unscreened ? { unscreened: true } : {}),
					};
				} else if (update.type === MessageUpdateType.AttachmentNotice && update.kind === "unread") {
					// A stored file this turn could not read back. Persists on reload. (CUR-3291)
					messageToWriteTo.unreadFilesNotice = update.message;
				} else if (update.type === MessageUpdateType.AttachmentNotice) {
					// This turn's files were refused because they could not be scanned; the
					// answer still streams. Persists on reload, mirroring safetyNotice. (CUR-2382)
					messageToWriteTo.attachmentNotice = { message: update.message };
					// Mark the left-out files on the sent message now, as the reload will. (CUR-3405)
					const question = messages.find((m) => m.id === messageToWriteTo.ancestors?.at(-1));
					if (question && update.leftOutFiles?.length) {
						const leftOut = new Set(update.leftOutFiles.map((f) => f.name));
						question.files = question.files?.filter((f) => !leftOut.has(f.name));
						question.leftOutFiles = update.leftOutFiles;
					}
				} else if (update.type === MessageUpdateType.InputScreen) {
					// Mirrors the server's allowed-turn stamp, so X-ray reads the check before a reload. (CUR-3963)
					messageToWriteTo.moderation = {
						...(messageToWriteTo.moderation ?? { flagged: false, label: null, score: 0, kind: "content_policy" }),
						screened: update.screened,
					};
				} else if (update.type === MessageUpdateType.SupportNotice) {
					// A self-harm distress rule let the turn through, so the answer leads with the
					// Support resources card. Mirrors the server stamp, which persists it for reload. (CUR-3915)
					messageToWriteTo.moderation = {
						...(messageToWriteTo.moderation ?? { flagged: false, label: null, score: 0, kind: "content_policy" }),
						support: true,
						...(update.supportLang ? { supportLang: update.supportLang } : {}),
						...(update.supportCountry ? { supportCountry: update.supportCountry } : {}),
						...(update.ruleLabel ? { ruleLabel: update.ruleLabel } : {}),
					};
				} else if (update.type === MessageUpdateType.AgentRouteNotice) {
					// Auto's route check failed, so the selected model answered. Persists on reload. (CUR-2830)
					messageToWriteTo.agentRouteFailed = true;
				} else if (update.type === MessageUpdateType.HistoryNotice) {
					// Older exchanges were left out so the chat fit the model. Persists on reload. (CUR-2893)
					messageToWriteTo.historyLeftOut = update.leftOut;
				} else if (update.type === MessageUpdateType.SafetyNotice) {
					// Non-blocking safety advisory (Coop "notice" tier): the turn was NOT declined, so
					// the answer still streams — this stamps a chip that rides alongside it stating why
					// the turn was noticed. Persists on reload, mirroring nameNotice.
					messageToWriteTo.safetyNotice = { message: update.message };
				} else if (update.type === MessageUpdateType.NameNotice) {
					// Post-generation name-adoption guard tripped: stamp the marker so an honest
					// "this system has no name" chip renders beside the answer (and persists on reload).
					messageToWriteTo.nameNotice = { name: update.name };
				} else if (update.type === MessageUpdateType.FixedReply) {
					// The server answered with a fixed string and no model ran; the receipt says so. (CUR-1579)
					messageToWriteTo.fixedReply = { kind: update.kind };
				} else if (update.type === MessageUpdateType.Calculation) {
					// Code evaluated one of the model's calculate calls; the expression shows live. (CUR-2273)
					messageToWriteTo.calculations = calculationAppended(
						messageToWriteTo.calculations,
						update
					);
				} else if (update.type === MessageUpdateType.McpCall) {
					// One call to a configured MCP server; the trace shows it live. (CUR-3026)
					messageToWriteTo.mcpCalls = mcpCallAppended(messageToWriteTo.mcpCalls, update);
				} else if (update.type === MessageUpdateType.Failover) {
					// The primary didn't answer and a backup model took over; the live log and
					// the receipt both show the switch. (CUR-2239)
					messageToWriteTo.failover = { from: update.from, to: update.to, reason: update.reason };
				} else if (update.type === MessageUpdateType.Rag) {
					// RAG retrieval ran server-side before generation. Stamp provenance so the
					// trace + map highlight appear during streaming. Shape owned by ragProvenance.
					const ragStamp = ragProvenance(update);
					if (ragStamp) messageToWriteTo.rag = ragStamp;
				} else if (update.type === MessageUpdateType.WebSearch) {
					// Open-web search ran server-side (community-first: after RAG). Stamp provenance so the
					// citations strip + map highlight appear live during streaming, mirroring the Rag stamp.
					// Shape owned by searchProvenance (shared with the server stamp) so the two can't drift.
					const webStamp = searchProvenance(update);
					if (webStamp) {
						messageToWriteTo.webSearch = webStamp;
						// A native turn's later search grounded it, so an earlier failed one no longer applies.
						messageToWriteTo.searchAttempt = undefined;
						if (browser) {
							window.dispatchEvent(
								new CustomEvent("ap:flash", { detail: { ids: [WEBSEARCH_NODE] } })
							);
						}
					}
				} else if (update.type === MessageUpdateType.SearchAttempt) {
					// The open-web search path was engaged server-side but never grounded the turn. Stamp the
					// honest attempt marker so the expanded trace can say so live, instead of silently reading
					// as "no search considered at all" once the turn lands. Mutually exclusive with webSearch.
					messageToWriteTo.searchAttempt = {
						grounded: false,
						searched: update.searched,
						...(update.failed ? { failed: update.failed } : {}),
					};
				} else if (update.type === MessageUpdateType.Mcp) {
					// An MCP open component (open HF Space tool) ran for this turn. Stamp provenance so the
					// trace reads "open component" live, not "from training". Shape owned by mcpProvenance.
					const mcpStamp = mcpProvenance(update);
					if (mcpStamp) messageToWriteTo.mcp = mcpStamp;
				} else if (update.type === MessageUpdateType.WritePolicy) {
					// This caller's writes were resolved to deny_writes for the task (CUR-471). Stamp
					// provenance so the badge appears live during streaming, not only after reload. Shape
					// owned by writePolicyProvenance — only a real restriction ever stamps.
					const writePolicyStamp = writePolicyProvenance(update);
					if (writePolicyStamp) messageToWriteTo.writePolicy = writePolicyStamp;
				} else if (update.type === MessageUpdateType.AgentTools) {
					// The agent observed at least one real ACP tool run this turn (CUR-601). Stamp provenance so
					// the trace reads "ran tools" live, not "from training". Shape owned by agentToolsProvenance
					// — only a genuinely tool-running turn ever stamps.
					const agentToolsStamp = agentToolsProvenance(update);
					if (agentToolsStamp) messageToWriteTo.agentTools = agentToolsStamp;
				} else if (update.type === MessageUpdateType.UnrunCode) {
					// This turn's answer is predicted, not measured (CUR-1341). Stamp it live so the reasoning
					// panel's header stops saying "Computed" as the turn lands, rather than only correcting
					// itself after a reload. Shape owned by unrunCodeProvenance, same as the stamps above.
					const unrunStamp = unrunCodeProvenance(update);
					if (unrunStamp) messageToWriteTo.unrunCode = unrunStamp;
				} else if (update.type === MessageUpdateType.AgentConfirm) {
					// Agent-service opened a confirmation gate mid-run (CUR-218). Stamp it LIVE — unlike every
					// other provenance stamp here, ChatMessage renders this while the turn is still loading,
					// since the whole point is a human acting on it before the 45s window (or whatever
					// agent-service is configured for) closes.
					messageToWriteTo.agentConfirmations = agentConfirmOpened(
						messageToWriteTo.agentConfirmations,
						update
					);
				} else if (update.type === MessageUpdateType.AgentConfirmResult) {
					// The pause above resolved. Same accumulate-in-place shape as the open side.
					messageToWriteTo.agentConfirmations = agentConfirmResolved(
						messageToWriteTo.agentConfirmations,
						update
					);
				}
				publishReplay?.("streaming");
			}

			if (buffer.length > 0) {
				flushBuffer(new Date());
			}

			// Autoplay a freshly-generated clip through the clip's shared element (audioPlayback.ts), the
			// same one the answer's player drives, so the player shows it playing (CUR-2299). Deduped per
			// message id so the duplicate-generation edge (which completes a turn twice) can't double-play.
			// Live completion only (not an abort), so a reload/history render never replays. Best-effort:
			// a policy block just leaves the player for a manual press.
			const clip = messageToWriteTo.mcp?.audio;
			if (
				page.data.readAloudEnabled &&
				get(speakMode) !== "off" &&
				!$isAborted &&
				clip &&
				!autoplayedAudioIds.has(messageToWriteTo.id) &&
				typeof Audio !== "undefined"
			) {
				autoplayedAudioIds.add(messageToWriteTo.id);
				void clipAudio(clip)
					.then((el) => playExclusive(el))
					.catch(() => {
						/* Fetch failed or timed out, or autoplay was refused — the player remains for a manual press */
					});
			}

			// The watchdog aborted before any token rendered, which ends the stream
			// cleanly (reader.cancel resolves the read as done) rather than throwing —
			// so handle the EARLY-failure path here too, not just in catch.
			if (watchdogTimedOut) {
				await applyEarlyStreamFailure?.();
			} else if (staleConnectionDetected) {
				// Same clean-end shape as the early-failure case, but content HAD already
				// streamed — see handleStalledConnection for why this branches differently. (CUR-708)
				handleStalledConnection?.();
			}
		} catch (err) {
			if ($isAborted || (err instanceof DOMException && err.name === "AbortError")) {
				// The watchdog also aborts the request, which on some platforms surfaces
				// here as a thrown AbortError rather than a clean stream end. If that's why
				// we're here (no user Stop), take whichever watchdog path fired; otherwise
				// this is a genuine user Stop, not an error.
				if (watchdogTimedOut) {
					await applyEarlyStreamFailure?.();
				} else if (staleConnectionDetected) {
					handleStalledConnection?.();
				}
			} else if (err instanceof Error && err.message.includes("overloaded")) {
				requestRefused = true;
				$error = "Too much traffic, please try again.";
			} else if (err instanceof Error && isRateLimitMessage(err.message)) {
				// Only our own limiter's copy (CUR-2805): a provider's 429 that merely contains the
				// number is not the visitor sending too much, and must not say so.
				requestRefused = true;
				$error = ERROR_MESSAGES.rateLimited;
			} else if (!firstContentSeen && applyEarlyStreamFailure) {
				// EARLY failure: a non-abort stream/connection error threw before any
				// token rendered — same regime as the watchdog timeout, so take the same
				// path (cached answer if we have one, else a retryable message) rather
				// than surfacing a raw browser error string. Guarded on the handler being
				// assigned: an error thrown before that point falls through to a real message.
				await applyEarlyStreamFailure();
			} else if (isLateConnectionLoss(err) && handleLateConnectionLoss) {
				// LATE network failure: reading the answer's body failed, so the connection dropped. Only the
				// read is tagged (CUR-2912): any other TypeError is our own bug and shows its own message.
				handleLateConnectionLoss();
			} else if (err instanceof Error) {
				// LATE failure: a partial answer is already on screen — keep it and
				// surface the error rather than replacing it with a fallback.
				requestRefused = true;
				$error = err.message;
			} else {
				requestRefused = true;
				$error = ERROR_MESSAGES.default;
			}
			console.error(err);
			// A genuine error this turn (not a user Stop / benign abort). Flag it locally so the
			// outcome telemetry never depends on the cross-turn $error store. Specific flags
			// (watchdog/early-5xx/shed) still take precedence in the reason ladder.
			if (!$isAborted && !(err instanceof DOMException && err.name === "AbortError")) {
				turnErrored = true;
			}
		} finally {
			repickWait.set(null);
			clearOwnPendingTurn?.();
			// A new agent turn whose run was handed off reads as running until the page re-attaches to it.
			if (
				page.data.agentRunHandoffEnabled === true &&
				turnAnswer &&
				handedOffAgentRun(turnAnswer.updates)
			) {
				handedOff = true;
				// This turn follows its own run below, after its save lands; the reload effect stays out.
				followedAgentRuns.add(turnAnswer.id);
				reattachDeadline = agentRunReattachDeadline(turnAnswer, Date.now(), page.data.agentRunHandoffEnabled === true);
			}
			// An attach either goes again, keeping what is shown, or settles the answer now. (CUR-3875)
			const reattaching = willReattach();
			if (handedOff && reattaching && turnAnswer) {
				Object.assign(turnAnswer, {
					updates: (turnAnswer.updates ?? []).filter((update) => !endsTheTurn(update)),
					interrupted: false,
				});
			}
			attachWantsAnother = reattaching;
			publishReplay?.(reattaching ? "streaming" : cleanFinalSeen ? "final" : "gave-up");
			// The inner try/finally exists for ONE invariant: `localTurnSyncHold` must release no
			// matter which branch runs or what throws anywhere in this cleanup — a wedged hold would
			// veto the data-driven resync forever. It wraps the WHOLE cleanup (not just the refresh
			// tail) so a future throwing statement added anywhere above the release can't wedge it.
			try {
				// Always dispose the watchdog (its timer AND its visibilitychange listener) so a late
				// fire can't abort a later request.
				watchdogHandle?.dispose();
				watchdogHandle = undefined;
				writeMessageInFlight = false;
				activeGenerationId = undefined;
				$loading = false;
				pending = false;
				synthesizingAudioFor.set(null); // clear the "Generating audio…" footer marker
				currentPhase.set(null); // clear the live phase marker (request log)
				// Wait for the stop request to complete before refreshing data,
				// so the abort marker is durably written before we poll for the
				// terminal state below.
				if (stopRequestPromise) {
					await stopRequestPromise.catch(() => {});
					stopRequestPromise = undefined;
				}
				const stoppedHere = stopRequestedFor === convId;
				// Only re-run the loads that actually need fresh data: the
				// conversation page (new messages) and the sidebar list
				// (updated title / updatedAt via client-owned store refresh).
				// Avoids the 5 redundant bootstrap requests (models, settings, user,
				// public-config, feature-flags) that a full invalidateAll() would trigger.
				// When this finally runs because beforeNavigate aborted the stream
				// ($isAborted set without a stop click), invalidating would cancel
				// that very navigation (e.g. the "New Chat" click that triggered
				// the abort) before the router even exposes it via `navigating`.
				// Skip the refresh: the destination page loads its own data.
				const abortedByNavigation = $isAborted && !stoppedHere;
				// Chat-health outcome: emit exactly one terminal event per turn. A pure
				// navigation-abort is not a real turn result, so skip it. Keep telemetry
				// isolated so analytics can never disrupt cleanup or the authoritative refresh.
				if (!abortedByNavigation) {
					try {
						const outcomeBase = {
							logged_in: !!page.data.user,
							model_requested: modelRequested ?? null,
							model_served: modelServed ?? null,
						};
						if (finalAnswerAt) {
							trackEvent("response_received", {
								...outcomeBase,
								latency_ms: finalAnswerAt - turnStartedAt,
								ttft_ms: firstTokenAt ? firstTokenAt - turnStartedAt : null,
								interrupted: stoppedHere,
							});
						} else {
							const reason = stoppedHere
								? "user_stopped"
								: capacityShed
									? "capacity_shed"
									: watchdogTimedOut
										? "ttft_timeout"
										: staleConnectionDetected
											? "stale_connection" // CUR-708: content streamed, then the connection went dark
											: requestFailedEarly
												? "early_5xx"
												: turnErrored
													? "error"
													: firstContentSeen
														? "incomplete"
														: "empty";
							trackEvent("response_error", { ...outcomeBase, reason });
						}
					} catch {
						/* never let analytics disrupt the turn */
					}
				}
				// The next attach follows at once; the server's copy is the emptied one until it ends. (CUR-3875)
				if (!abortedByNavigation && !reattaching) {
					// stop-generating returns as soon as the abort marker is written,
					// NOT when the generating pod has persisted interrupted:true.
					// Invalidating right away would load a non-terminal snapshot that
					// wipes the optimistic interrupted flag and shows a stuck
					// streaming state. Wait (bounded) for the persisted state to
					// become terminal before refreshing.
					if (stoppedHere) {
						const settled = await waitForTerminalPersist(convId);
						// A Stop before any of the reply arrived can land before the server has
						// saved the question. Its copy then lacks the turn, and syncing to it would blank
						// the pane, question and stopped notice both. Keep the local turn under the same
						// veto a client-only cached answer uses; its timer reconciles once the turn is saved. (CUR-3018)
						if (
							stoppedTurnMissingFromSnapshot({
								firstContentSeen,
								turnMessageId: turnAnchorId,
								snapshot: settled,
							})
						) {
							setCacheFallback(convId);
						}
					}
					if (cacheFallbackConvId === convId) {
						// The connection dropped before the server persisted this turn, so we
						// painted a pre-vetted cached answer client-side. A conversation
						// re-sync here would reconcile `messages` back to the empty/partial
						// server snapshot and WIPE that answer (and the optimistic user turn),
						// leaving a silently empty conversation. Skip the reload; still refresh
						// the sidebar, which reads its own store. The cached answer is transient
						// (gone on navigation/reload) — correct, since nothing was persisted;
						// the user can resend to get a real, persisted turn.
						// (This branch deliberately has NO authoritative post-turn resync; after
						// the hold releases below, the cacheFallback veto keeps guarding it.)
						await convsStore.refresh();
					} else {
						// Post-turn authoritative refresh, retried until OBSERVED applied: a
						// concurrent invalidate (poller terminal event, eviction, devtools) can
						// supersede ours via the router's latest-wins token, making it resolve
						// WITHOUT applying — releasing the hold on mere resolution would let the
						// reconcile effect apply whatever stale snapshot was parked during the
						// stream. Identity is the apply-detector (every load run constructs a
						// fresh data.messages). Attempt-bounded (not wall-clock-bounded) for
						// liveness; the sidebar refresh rides alongside, independent of the loop.
						await Promise.all([
							refreshUntilApplied({
								getCurrent: () => data.messages,
								invalidate: () => resyncConversation(),
							}),
							convsStore.refresh(),
						]);
					}
				}
			} finally {
				// Release AFTER the observed-applied refresh (or its bounded residual): the flip
				// re-runs the reconcile effect, which now applies the fresh post-turn snapshot. A later turn
				// that has since taken the hold keeps it, and releases it after its own refresh.
				if (localTurnSyncHoldOwner === turnHoldToken) {
					if (attachWantsAnother) {
						localTurnSyncHoldOwner = REATTACH_HOLD;
					} else {
						localTurnSyncHoldOwner = undefined;
						localTurnSyncHold = false;
					}
				}
				// The handed-off run is followed from here, as a reload would follow it.
				if (handedOff && attachWantsAnother && turnAnswer)
					void followAgentRun(attachConvId, turnAnswer.id, { pauseFirst: true });
			}
		}
	}

	// Poll the conversation API until the last assistant message is terminal
	// (interrupted, final answer, or error persisted), bounded at ~3.2s. Used
	// after a Stop so the post-stop refresh reads settled data instead of a
	// mid-abort snapshot.
	// Returns the last snapshot read, or undefined when none could be read.
	async function waitForTerminalPersist(id: string): Promise<Message[] | undefined> {
		const client = useAPIClient();
		let last: Message[] | undefined;
		for (let attempt = 0; attempt < 8; attempt++) {
			try {
				const conversation = (await client.conversations({ id }).get().then(handleResponse)) as {
					messages: Message[];
				};
				last = conversation.messages;
				if (!isConversationGenerationActive(conversation.messages)) return last;
			} catch {
				return last; // cannot verify; fall through to the single refresh
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
		}
		return last;
	}

	async function stopGeneration() {
		// Snapshot the stop point first: the generation run this tab started
		// (if any) and how many characters of the reply are on screen right
		// now. The server clamps the persisted text back to this so the
		// interrupted message cannot "grow back" past what the user saw while
		// the abort marker was in flight.
		commitHeldTokens?.();
		const lastAssistant = messages.findLast((m) => m.from === "assistant");
		const stopPoint =
			activeGenerationId !== undefined && lastAssistant
				? { generationId: activeGenerationId, seenContentLength: lastAssistant.content.length }
				: undefined;

		stopRequestedFor = convId;
		$isAborted = true;
		$loading = false;
		messageUpdatesAbortController.abort();

		// Mark the last assistant message as interrupted locally so
		// isConversationGenerationActive() immediately returns false,
		// removing the background poller and preventing $loading re-enable.
		if (lastAssistant) {
			lastAssistant.interrupted = true;
		}

		const sendStopRequest = async () => {
			const response = await fetch(`${base}/conversation/${page.params.id}/stop-generating`, {
				method: "POST",
				...(stopPoint && {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(stopPoint),
				}),
			});
			if (!response.ok) {
				throw new Error(`Stop request failed: ${response.status}`);
			}
		};

		// Store the promise so writeMessage's finally block can await it
		// before refreshing data. Losing this request entirely means the server
		// never learns about the stop (the abort marker is what cross-pod
		// generation watchers act on), so retry with backoff instead of giving
		// up after a single transient failure.
		stopRequestPromise = (async () => {
			const delays = [0, 300, 1000, 3000];
			for (const [attempt, delay] of delays.entries()) {
				if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
				try {
					await sendStopRequest();
					return;
				} catch (err) {
					if (attempt === delays.length - 1) {
						console.error("Failed to stop generation", err);
						$error = "Failed to stop generation. Please try again.";
					}
				}
			}
		})();

		await stopRequestPromise;
	}

	function handleKeydown(event: KeyboardEvent) {
		// Stop generation on ESC key when loading
		if (event.key === "Escape" && $loading) {
			event.preventDefault();
			stopGeneration();
		}
	}

	onMount(async () => {
		// Read the first message from SvelteKit shallow-routing history state.
		// Text is serialized directly; File objects travel via the pendingFiles
		// client-side Map, retrieved once by nonce and then discarded.
		// On a hard refresh page.state is empty, so both values are undefined
		// and we skip straight to the background-generation check below.
		const pendingText = page.state.pendingMessage as string | undefined;
		if (pendingText) {
			const nonce = page.state.pendingFilesNonce as string | undefined;
			files = nonce ? consumePendingFiles(nonce) : [];
			// Clear the history entry before submitting: returning to it via
			// Back/Forward re-runs onMount, and a lingering pendingMessage
			// would resubmit the prompt (without files, whose nonce is spent).
			// (Web-search grounding for the first turn now happens server-side on the first POST,
			// community-first — no client-resolved searchContext to hand off.)
			replaceState("", {});
			await sendThenRepick(pendingText, () => writeMessage({ prompt: pendingText }));
		}

		// Don't resume tracking for stale snapshots: a generation that has gone
		// this long without a DB write died with its pod and will never finish.
		// Also skip a turn that just resolved to a client-only cache fallback: the
		// cache-painted assistant has no terminal update, so it would otherwise read
		// as active and register a background generation whose poller then wipes it.
		const streaming =
			cacheFallbackConvId !== convId &&
			isConversationGenerationActive(messages) &&
			!isGenerationStale(data.updatedAt);
		if (streaming) {
			addBackgroundGeneration({ id: convId, startedAt: Date.now() });
			$loading = true;
		} else if (!pendingText) {
			const awaited = pendingTurnToAwait(
				convId,
				messages.map((m) => m.id)
			);
			if (awaited) void followPendingTurn(convId, awaited);
			// An agent run outlives the tab that started it. Coming back to one, pick it up again:
			// the answer fills in from the task's events, finished or still going. (CUR-993)
			const reattach = agentRunToReattach(messagesPath);
			const followedHere =
				page.data.agentRunHandoffEnabled === true && reattach && followedAgentRuns.has(reattach.id);
			if (reattach && !followedHere) await followAgentRun(convId, reattach.id);
		}
	});

	// Agent runs followed since this conversation was opened, so each is followed once per visit; the
	// component outlives a client navigation, so the set is cleared on a change of conversation (CUR-4410).
	// eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping read inside untrack, never rendered
	const followedAgentRuns = new Set<string>();
	let followedAgentRunsConv = "";

	// A page loaded while another request was still reading the run (a reload mid-follow) tracks that
	// request in the background; when it hands the run off in turn, follow the run from here rather than
	// leave the "still working" text up until the next reload (CUR-4410). Flag off: unchanged.
	$effect(() => {
		const conv = convId;
		const reattach = agentRunToReattach(messagesPath);
		untrack(() => {
			if (conv !== followedAgentRunsConv) {
				followedAgentRuns.clear();
				followedAgentRunsConv = conv;
			}
		});
		if (!reattach || $loading || page.data.agentRunHandoffEnabled !== true) return;
		untrack(() => {
			if (writeMessageInFlight || followedAgentRuns.has(reattach.id)) return;
			void followAgentRun(convId, reattach.id);
		});
	});

	/**
	 * Re-attach to an agent run until it hands back its answer or reaches its ceiling (CUR-3875). An
	 * attach stream can end before the run does: the request's own deadline, or a silence the page reads
	 * as a dead connection. The answer stays on screen and running between attempts; only the last
	 * attempt settles it, as finished or interrupted.
	 */
	async function followAgentRun(id: string, messageId: string, opts: { pauseFirst?: boolean } = {}) {
		followedAgentRuns.add(messageId);
		try {
			// A run handed off by the turn that started it: let that turn's own save land first.
			if (opts.pauseFirst) {
				await new Promise((resolve) => setTimeout(resolve, REATTACH_PAUSE_MS));
				if (page.params.id !== id || stopRequestedFor === id) return;
			}
			for (;;) {
				await writeMessage({ messageId, attach: true });
				if (!attachWantsAnother) return;
				await new Promise((resolve) => setTimeout(resolve, REATTACH_PAUSE_MS));
				if (page.params.id !== id || stopRequestedFor === id) return;
			}
		} finally {
			attachWantsAnother = false;
			if (localTurnSyncHoldOwner === REATTACH_HOLD) {
				localTurnSyncHoldOwner = undefined;
				localTurnSyncHold = false;
			}
		}
	}

	/**
	 * Wait for a turn this tab sent before a reload, which the server had not saved yet (CUR-1893).
	 * Refreshes the snapshot until the turn's message is in it, then hands a still-running turn to the
	 * background poller, the way a load that caught the turn mid-answer does. A turn that never
	 * arrives inside PENDING_TURN_MAX_MS was lost before the server saved it.
	 */
	async function followPendingTurn(id: string, messageId: string) {
		$loading = true;
		const deadline = Date.now() + PENDING_TURN_MAX_MS;
		try {
			while (Date.now() < deadline && page.params.id === id) {
				await new Promise((resolve) => setTimeout(resolve, 2_000));
				await resyncConversation();
				if (!data.messages.some((m) => m.id === messageId)) continue;
				if (isConversationGenerationActive(data.messages)) {
					addBackgroundGeneration({ id, startedAt: Date.now() });
					return;
				}
				$loading = false;
				return;
			}
			if (page.params.id === id) $loading = false;
		} finally {
			clearPendingTurn(id);
		}
	}

	// The model is chosen per message (routing/state.ts `nextTurnModel`): when the composer settled on
	// a different one for this message, the conversation is switched to it just before the POST, since
	// the server runs a turn on the conversation's model at send time. Earlier answers keep the model
	// that wrote them (routerMetadata.model). A failed switch leaves the model as it was — the message
	// still sends.
	let switchedModel = $state<{ conv: string; model: string } | undefined>();
	$effect(() => {
		void data.model;
		untrack(() => (switchedModel = undefined));
	});

	async function applyTurnModel(content: string) {
		const convId = page.params.id;
		const modelId = turnModelFor(content);
		// Compared with the model the conversation is on now, which an earlier switch may have changed
		// since `data.model` loaded: switching A → B → A has to PATCH back to A.
		const onNow = (switchedModel?.conv === convId ? switchedModel?.model : undefined) ?? data.model;
		if (!convId || !modelId || modelId.toLowerCase() === onNow?.toLowerCase()) return;
		try {
			const res = await fetch(`${base}/conversation/${convId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: modelId }),
			});
			if (!res.ok) return;
			switchedModel = { conv: convId, model: modelId };
			nextTurnModel.set(null);
		} catch {
			/* keep the current model */
		}
	}

	// A message sent before the composer's pause-in-typing analysis settled has no Auto choice
	// published for its text. Route it here, as the landing page does for a first message, so the turn
	// goes where Auto would send it and its X-ray can say why. A photo turn stays with the composer,
	// whose photo routing already holds for whatever is sent with it. (CUR-3944)
	function routeAtSend(content: string): AutoRouteNote | undefined {
		if (page.data.autoRoutingEnabled !== true || get(modelChoice) !== AUTO) return undefined;
		if (files.some((file) => file.type.startsWith("image/"))) return undefined;
		const onNow = (switchedModel?.conv === page.params.id ? switchedModel?.model : undefined) ?? data.model;
		const resolved = resolveModel(
			AUTO,
			content,
			data.models.map((model) => model.id),
			{
				analysis: analysisFor(content),
				benchmarks: get(activeBenchmarks),
				config: get(activeRoutingConfig),
				stickTo: catalogByGatewayId(onNow)?.id,
				busy: busyNow(serverBusyNow(page.data.busyModels as string[] | undefined, get(serverBusy)), get(busyHere)),
			}
		);
		if (!resolved.modelId || !resolved.route) return undefined;
		nextTurnModel.set({ modelId: resolved.modelId, text: content.trim() });
		return autoRouteNote(resolved.route);
	}

	// Set by writeMessage when the model Auto chose answered nobody (repick.ts) before any text. (CUR-4384)
	let repickFor: { answerId: Message["id"]; from: string } | undefined;

	async function onMessage(content: string) {
		// Read now: switching the model awaits a PATCH, and by then the cleared draft has dropped Auto's choice.
		const autoRoute = autoRouteFor(content) ?? routeAtSend(content);
		await applyTurnModel(content);
		// The composer stays open after a failed turn. When that turn failed before the server
		// stored its question, the page's copy is the only one, and a send built on it names a parent the
		// server has never seen: the post-turn refresh then left an empty page. Drop it and send under its
		// parent, as Retry's resend does (CUR-2803). (CUR-4494)
		const last = messagesPath.at(-1);
		const failed =
			last?.from === "assistant" ? messages.find((message) => message.id === last.ancestors?.at(-1)) : undefined;
		const unsaved = failed && !data.messages.some((message) => message.id === failed.id);
		const parentId = unsaved ? dropUnsavedTurn(failed) : undefined;
		await sendThenRepick(content, () =>
			unsaved ? writeMessage({ prompt: content, autoRoute, messageId: parentId }) : writeMessage({ prompt: content, autoRoute })
		);
	}

	/** Sends a new question; when the model Auto chose never starts, Auto asks another (CUR-4384). */
	async function sendThenRepick(content: string, send: () => Promise<void>) {
		const sentIn = page.params.id;
		repickFor = undefined;
		await send();
		const failed = repickFor as { answerId: Message["id"]; from: string } | undefined;
		repickFor = undefined;
		// The visitor may have left for another chat while the turn failed; Auto asks only where they are.
		if (!failed || page.params.id !== sentIn) return;
		// writeMessage marked the failed model busy here, so Auto now chooses among the others. The answer
		// is asked again over the failed one, built by the server for the model Auto chose this time.
		const next = routeAtSend(content);
		const note = next ? repickedNote(failed.from, next) : undefined;
		if (!note) return nextTurnModel.set(null);
		await applyTurnModel(content);
		await writeMessage({ messageId: failed.answerId, isRetry: true, autoRoute: note });
	}

	/** Removes a turn the server never stored from the page, and returns the parent it was sent under. */
	function dropUnsavedTurn(question: Message): Message["id"] | undefined {
		const parentId = question.ancestors?.at(-1);
		messages = messages.filter(
			(message) => message.id !== question.id && !message.ancestors?.includes(question.id)
		);
		const parent = messages.find((message) => message.id === parentId);
		if (parent) parent.children = parent.children?.filter((id) => id !== question.id);
		if (rootMessageId === question.id) rootMessageId = undefined;
		return parentId;
	}

	// Set by writeMessage when the server answers a plain Retry with "Message not found" (CUR-2803).
	let retryTargetMissing = false;

	async function onRetry(payload: { id: Message["id"]; content?: string }) {
		if (requireAuthUser()) return;

		const answer = messages.find((message) => message.id === payload.id);
		const question =
			payload.content === undefined && answer?.from === "assistant"
				? messages.find((message) => message.id === answer.ancestors?.at(-1))
				: undefined;
		// writeMessage sets pinnedLeafId to the new branch's leaf once it's created;
		// nothing to pin here yet.
		await writeMessage({
			prompt: payload.content,
			messageId: payload.id,
			isRetry: true,
		});
		if (!retryTargetMissing || !question) return;

		// The server never stored this turn (the send failed before the question was saved),
		// so there is no answer of its to retry. Drop the page's copy of the turn and ask the question
		// again under the same parent, the way the first send did. (CUR-2803)
		await writeMessage({
			prompt: question.content,
			messageId: dropUnsavedTurn(question),
			resendFiles: question.files,
		});
	}

	async function onShowAlternateMsg(payload: { id: Message["id"] }) {
		pinnedLeafId = payload.id;
	}

	let messages = $state(untrack(() => data.messages));
	// Local copy of rootMessageId avoids mutating the load-data prop directly.
	// It is set when the first message of a new conversation is created, and
	// re-synced from server data whenever the conversation changes.
	let rootMessageId = $state(untrack(() => data.rootMessageId));

	// Resync local message state from server data ONLY when the conversation
	// changes (sidebar navigation) or the load data itself was refreshed
	// (post-stream invalidation). Three hard constraints:
	//
	// 1. `pending` must NOT be a reactive dependency of this effect — nor a guard at all
	//    anymore. It flips false when the first streaming token arrives: read tracked, that
	//    flip re-ran the effect and overwrites the locally appended user/assistant messages
	//    with the stale page-load snapshot; read untracked as the
	//    guard, it leaves the ENTIRE post-first-token stream unprotected — a conversation
	//    invalidate landing mid-stream swaps `messages` to the server snapshot, orphaning
	//    the live stream's write target and painting the PREVIOUS turn's answer under the
	//    new prompt (cross-turn spillage).
	// 2. A sync may only happen when `data.messages` identity actually changed
	//    (or the conversation changed): re-running this effect for any other
	//    reason must be a no-op.
	// 3. The mid-turn veto is `localTurnSyncHold`, read TRACKED on purpose (the one deliberate
	//    exception to the "flags read untracked" rule): setting it re-runs the effect into a
	//    veto (no-op — the first hazard above is the guard PASSING on a flip, which cannot
	//    happen here), and releasing it re-runs the effect to apply the post-turn snapshot.
	//    The release only happens after writeMessage's finally has OBSERVED its refresh apply
	//    (see refreshUntilApplied) — a stale load parked during the stream can therefore never
	//    be the snapshot the release applies, short of the documented bounded residual.
	// 4. `reportActionHoldCount` (CUR-1583) is a second, independent veto for a hazard one beat
	//    AFTER `localTurnSyncHold` releases: the post-turn snapshot re-mints message ids, and a
	//    "Report a problem" submission started in that narrow window would have its ReportButton
	//    destroyed and re-created mid-action, silently discarding the acknowledgement the user is
	//    watching for. It only ever makes the sync MORE conservative: both hazards above come
	//    from the guard passing when it shouldn't, so an added veto can't reintroduce either.
	//
	// A mid-turn load refresh (hold up) is intentionally skipped; the finally block in
	// writeMessage refreshes-until-applied after the turn ends, so the post-completion
	// sync still lands.
	let _lastSyncedConvId = untrack(() => convId); // plain variable — no reactive overhead needed
	let _lastSyncedMessages = untrack(() => data.messages); // plain variable — identity tracking only
	$effect(() => {
		const currentConvId = convId; // reactive dep
		const newMessages = data.messages; // reactive dep

		const convChanged = currentConvId !== _lastSyncedConvId;
		const dataChanged = newMessages !== _lastSyncedMessages;

		// Additionally: a client-only cache fallback is painted for THIS conversation
		// (the server never recorded the turn), so a data-driven sync would reconcile
		// `messages` to the empty server snapshot and wipe the answer. Block the
		// data-change sync (read untracked per constraint #1). A genuine conversation
		// change still syncs — the guard is keyed to the current conv id, never set for
		// a conv we're navigating to — and a resend clears the flag.
		const cacheFallbackHere = untrack(() => cacheFallbackConvId) === currentConvId;

		if (
			shouldSyncMessagesFromData({
				convChanged,
				dataChanged,
				localTurnSyncHold, // TRACKED — see constraint #3
				cacheFallbackHere,
				// What the veto above is actually protecting against is an EMPTY snapshot.
				// Derived from the delivery being decided on, so a snapshot carrying a real, finished
				// answer lifts it and the turn the server completed reaches the screen. (CUR-1660)
				snapshotHasAnswer: serverSnapshotHasAnswer(newMessages),
				reportActionPending: $reportActionHoldCount > 0, // TRACKED — see constraint #4
			})
		) {
			messages = newMessages;
			rootMessageId = data.rootMessageId;
			_lastSyncedConvId = currentConvId;
			_lastSyncedMessages = newMessages;
			// A pin from the previous conversation names an id that can't appear in this
			// one; harmless via createMessagesPath's own fallback, but clear it so a stale
			// pin can never coincide with an id in the new tree.
			if (convChanged) {
				pinnedLeafId = undefined;
			}
		}
	});

	$effect(() => {
		const streaming =
			// A client-only cache fallback for this conv is a FINISHED turn, not an
			// active generation: its assistant carries no terminal update, so without
			// this guard it would keep the spinner on. Tracked, so the flag flipping at
			// watchdog time re-runs this effect and clears the spinner immediately.
			// A background generation is not re-registered here: the poller's invalidate can only apply a
			// snapshot that actually has an answer in it (`snapshotHasAnswer`, CUR-1660), so tracking a
			// conversation with a fallback painted is safe.)
			cacheFallbackConvId !== convId &&
			isConversationGenerationActive(messages) &&
			// A snapshot that has gone this long without a database write belongs
			// to a pod that died before persisting a terminal state; never
			// resurrect the streaming UI for it. Generations streaming in this
			// tab are exempt — their snapshot timestamp is from page-load time.
			(untrack(() => writeMessageInFlight) || !isGenerationStale(data.updatedAt));
		if (stopRequestedFor === convId) {
			$loading = false;
		} else if (streaming || pending) {
			// `pending` covers the pre-stream phase (safety check, sources) before the first token.
			// Leaving it out let a re-run here clear `$loading` mid-phase, which showed Send instead
			// of Stop and let a second message in while the first was still starting.
			$loading = true;
		} else {
			$loading = false;
		}

		// A cache fallback painted for THIS conversation is the one state where "not
		// streaming" does not mean "nothing left to wait for" — the client gave up 8s after the last
		// keepalive and the server carries on and persists the answer. Evicting here would drop the
		// registration applyEarlyStreamFailure just made, in the same beat, and the SSE terminal event
		// would arrive with nothing tracking it. Bounded by `setCacheFallback`'s own timer, which
		// clears the flag and re-runs this effect, and by the poller's own eviction. (CUR-1660)
		if (!streaming && browser && cacheFallbackConvId !== convId) {
			removeBackgroundGeneration(convId);
		}
	});

	// The leaf a retry/regenerate or branch switch selected. $derived values in Svelte 5 can be
	// reassigned, but only as a one-shot override: the next time `messages` itself changes — which
	// addSibling/addChildren do on every retry, immediately — the override is discarded and the
	// derived recomputes from its bare expression. createMessagesPath's own fallback for a missing
	// id is messages.at(-1), the most-recently-pushed node, which is only the right leaf when the
	// retried message was already the conversation's last turn. Routing every selection through this
	// state instead keeps the pin alive across those recomputes. See where it's set: writeMessage and
	// onShowAlternateMsg.
	let pinnedLeafId: TreeId | undefined = $state(undefined);

	// create a linear list of `messagesPath` from `messages` that is a tree of threaded messages
	let messagesPath = $derived(createMessagesPath(messages, pinnedLeafId));
	let messagesAlternatives = $derived(createMessagesAlternatives(messages));

	// The branch this tab was reading, so a reload reopens it (CUR-2860). Kept per tab and per
	// conversation in sessionStorage: one localStorage key shared by every tab reopened tab B on
	// tab A's branch. It is applied after mount, never during the first render, because the server
	// renders without it; Svelte keeps server-rendered text it disagrees with during hydration, so
	// a branch chosen in the first client render showed one turn's question over the other's answer.
	const leafKey = (id: string) => `leafId:${id}`;
	const savedLeafId = browser ? readSessionLeaf(leafKey(untrack(() => convId))) : null;
	function readSessionLeaf(key: string): string | null {
		try {
			return sessionStorage.getItem(key);
		} catch {
			return null;
		}
	}
	onMount(() => {
		if (pinnedLeafId === undefined && savedLeafId && messages.some((m) => m.id === savedLeafId)) {
			pinnedLeafId = savedLeafId;
		}
	});
	$effect(() => {
		const leaf = messagesPath.at(-1)?.id;
		if (!browser || !leaf) return;
		try {
			sessionStorage.setItem(leafKey(convId), leaf);
		} catch {
			// Storage can be blocked; a reload then shows the newest branch.
		}
	});

	beforeNavigate((navigation) => {
		if (!page.params.id) return;
		// A reload or tab close arrives here as "leave", before pagehide, and the abort below runs the
		// turn's finally at once. Marking it first keeps the pending-turn note the reload needs (CUR-1893).
		if (navigation.type === "leave") leavingPage = true;

		const navigatingAway =
			navigation.to?.route.id !== page.route.id || navigation.to?.params?.id !== page.params.id;

		if ($loading && navigatingAway) {
			addBackgroundGeneration({ id: page.params.id, startedAt: Date.now() });
		}
		// This page is reused from one conversation to the next, so files attached here and
		// never sent would otherwise ride along into the next one. (CUR-3052)
		if (navigatingAway) files = [];

		$isAborted = true;
		$loading = false;
		messageUpdatesAbortController.abort();
	});

	let title = $derived.by(() => {
		const rawTitle =
			convsStore.list.find((conv) => conv.id === page.params.id)?.title ?? data.title;
		return rawTitle ? rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1) : rawTitle;
	});

	// findCurrentModel falls back to models[0], which is undefined when models is
	// empty — its own return type claims Model, never Model | undefined, so every one of
	// ChatWindow's many unguarded currentModel.* reads (isRouter, id, multimodal, ...) throws
	// the instant that happens, with nothing here catching it. ChatLanding.svelte already
	// guards this same fallback before ever mounting ChatWindow; this page rendered it
	// unconditionally. (CUR-1141)
	let currentModel = $derived(
		findCurrentModel(
			data.models,
			(switchedModel?.conv === page.params.id ? switchedModel?.model : undefined) ?? data.model
		)
	);
</script>

<svelte:window onkeydown={handleKeydown} onpagehide={() => (leavingPage = true)} />

<svelte:head>
	<!-- CUR-1405: an unanswered agent confirmation prefixes the tab, because the card that asks for it
	     renders inside the message body and nowhere a backgrounded tab can show. Composed through
	     SvelteKit's own <title> rather than by assigning document.title, so navigation and the title
	     store stay the single owner of the string and there is nothing to restore afterwards. -->
	<title>{confirmTitle(title, pendingConfirm.count)}</title>
</svelte:head>

{#if currentModel}
	{@const model = currentModel}
	<ChatWindow
		loading={$loading}
		{pending}
		messages={$wipeCommitted ? [] : (messagesPath as Message[])}
		{messagesAlternatives}
		shared={data.shared}
		formerWorkspace={data.formerWorkspace ?? null}
		preprompt={data.preprompt}
		bind:files
		onmessage={onMessage}
		onretry={onRetry}
		onshowAlternateMsg={onShowAlternateMsg}
		onstop={stopGeneration}
		models={data.models}
		currentModel={model}
	/>
{:else}
	<NoModelsAvailable />
{/if}

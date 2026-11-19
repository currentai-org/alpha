// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { Message } from "$lib/chat/types/Message";
import { showsLiveProvenanceTrace } from "$lib/chat/messageProvenance";
import { MessageUpdateStatus, MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import { AGENT_HANDOFF_RUN_CEILING_MS, AGENT_RUN_CEILING_MS, GENERATION_STALE_MS } from "./deadlineLadder";

export function isAssistantGenerationTerminal(message?: Message): boolean {
	if (!message || message.from !== "assistant") return true;

	if (message.interrupted === true) return true;

	const updates = message.updates ?? [];
	const hasFinalAnswer = updates.some((update) => update.type === MessageUpdateType.FinalAnswer);
	if (hasFinalAnswer) return true;

	return updates.some(
		(update) =>
			update.type === MessageUpdateType.Status &&
			(update.status === MessageUpdateStatus.Error ||
				update.status === MessageUpdateStatus.Finished)
	);
}

// A typed per-message status the UI can key off in one place, instead of inferring from
// scattered booleans. `incomplete` is the honest-degradation state the product cares about: the
// stream ended without a clean finish (user stop, or a generation that died after partial tokens) —
// distinct from `error` (an explicit failure status) so the UI can say "response was interrupted"
// over the partial content rather than letting it look complete. Mirrors the assistant-ui message
// state machine (running | complete | incomplete | error), reimplemented over our update stream.
export type MessageStatus = "running" | "complete" | "incomplete" | "error";

export function deriveMessageStatus(message?: Message): MessageStatus {
	if (!message || message.from !== "assistant") return "complete";
	if (!isAssistantGenerationTerminal(message)) return "running";

	const updates = message.updates ?? [];
	// An explicit error status wins: surface the failure plainly over anything else.
	const hasError = updates.some(
		(update) =>
			update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.Error
	);
	if (hasError) return "error";

	// Interrupted: the persisted flag (user stop / stuck-generation watchdog) or a final-answer
	// update explicitly flagged interrupted. Partial content is preserved; we render it honestly.
	const interrupted =
		message.interrupted === true ||
		updates.some(
			(update) => update.type === MessageUpdateType.FinalAnswer && update.interrupted === true
		);
	if (interrupted) return "incomplete";

	return "complete";
}

/**
 * Is this assistant turn still actively producing content? Neither `loading` (the client fetch
 * flag) nor `deriveMessageStatus(message) === "running"` (no terminal update yet) is safe alone —
 * each can lag the other by a beat, so a check gated on only one reads "finished" a moment before
 * the turn actually is. two different UI surfaces hit this from the same gap
 * before adopting this composition (see `shouldShowEmptyAnswerNotice` and ChatMessage's
 * `isProcessStreaming`).
 */
export function isTurnStillRunning(loading: boolean, message?: Message): boolean {
	return loading || deriveMessageStatus(message) === "running";
}

export function isConversationGenerationActive(messages: Message[]): boolean {
	const lastAssistant = [...messages].reverse().find((message) => message.from === "assistant");
	if (!lastAssistant) return false;

	return !isAssistantGenerationTerminal(lastAssistant);
}

/**
 * The answer at the end of the visible thread, when it is an agent run the tab lost and could pick up
 * again: interrupted, holding the task it started, and not closed by Stop or by agent-service
 * forgetting it. Anything else leaves the page as it is.
 */
export function agentRunToReattach(path: Message[]): Message | undefined {
	const last = path.at(-1);
	if (last?.from !== "assistant" || !last.interrupted) return undefined;
	return last.agentRun && !last.agentRun.closed ? last : undefined;
}

/**
 * Did this turn hand its agent run off to the page? The run outlasted the request, so the server stopped
 * reading it before its watchdog and stored the answer interrupted with the run still open
 * (deadlineLadder.ts agentHandoffAt). The page that sent the turn then follows the run, as a reload
 * would (agentRunToReattach). A turn ended by an error, or a run that is closed, is not one.
 *
 * only a run the server stored as submitted to hand off (`handoff` on its AgentRun update)
 * counts. The page never consults its own copy of `agent-run-handoff`, which is read once at tab load
 * on another instance and can disagree with the server that handed the run off.
 */
export function handedOffAgentRun(updates: MessageUpdate[] | undefined): boolean {
	const list = updates ?? [];
	const run = list.findLast((u) => u.type === MessageUpdateType.AgentRun);
	const final = list.findLast((u) => u.type === MessageUpdateType.FinalAnswer);
	const errored = list.some(
		(u) => u.type === MessageUpdateType.Status && u.status === MessageUpdateStatus.Error
	);
	return (
		run?.type === MessageUpdateType.AgentRun &&
		run.handoff === true &&
		run.closed !== true &&
		final?.type === MessageUpdateType.FinalAnswer &&
		final.interrupted === true &&
		!errored
	);
}

/**
 * When a page stops re-attaching to an agent run: the run's ceiling, counted from when its
 * answer was first written. An attach keeps the answer's `createdAt`, so this is the run's own start,
 * not the latest re-attach. A message with no readable start counts from `now`. With `agent-run-handoff`
 * on the ceiling covers every attempt the service may make.
 */
export function agentRunReattachDeadline(
	message: Pick<Message, "createdAt">,
	now: number,
	handoff = false
): number {
	const started = message.createdAt ? new Date(message.createdAt).getTime() : Number.NaN;
	return (Number.isFinite(started) ? started : now) + (handoff ? AGENT_HANDOFF_RUN_CEILING_MS : AGENT_RUN_CEILING_MS);
}

/** An update that ends a turn: a final answer, or an error or finished status. */
export function endsTheTurn(update: MessageUpdate): boolean {
	return (
		update.type === MessageUpdateType.FinalAnswer ||
		(update.type === MessageUpdateType.Status &&
			(update.status === MessageUpdateStatus.Error || update.status === MessageUpdateStatus.Finished))
	);
}

/**
 * What a re-attached agent answer shows while the task's events replay into a copy of it.
 *
 * The server rebuilds the answer from the run's first event, so the copy starts empty. Writing that
 * straight onto the screen blanked an answer the person was already reading. Instead the screen keeps
 * `held` until the copy has caught up with it:
 *   - `streaming`: the copy once it is at least as long as what is shown, minus anything that ends the
 *     turn, since whether this attach ends it is not known yet; undefined (keep `held`) before that.
 *   - `final`: the attach ended with a real answer, so the copy as it stands.
 *   - `gave-up`: the attach ended without one and the page will not try again, so the copy's ending
 *     with the longer of the two texts, never less than was shown.
 */
export function reattachView(
	held: Pick<Message, "content">,
	replay: Pick<Message, "content" | "updates" | "interrupted">,
	mode: "streaming" | "final" | "gave-up"
): Pick<Message, "content" | "updates" | "interrupted"> | undefined {
	const updates = replay.updates ?? [];
	if (mode === "final") return { content: replay.content, updates, interrupted: replay.interrupted };
	if (mode === "gave-up") {
		const content = replay.content.length >= held.content.length ? replay.content : held.content;
		return { content, updates, interrupted: replay.interrupted };
	}
	if (replay.content.length < held.content.length) return undefined;
	return { content: replay.content, updates: updates.filter((u) => !endsTheTurn(u)), interrupted: false };
}

/**
 * Does a server snapshot carry a finished assistant answer with words in it?
 *
 * This is the question `cacheFallbackHere` alone cannot answer, and the one
 * `shouldSyncMessagesFromData` needs below. An EMPTY server snapshot is what the cache-fallback
 * veto exists to protect the optimistic turn from; a snapshot holding a real, terminal answer is
 * the opposite case, and blocking it leaves the user watching a turn that finished somewhere else.
 *
 * Deliberately stricter than `isAssistantGenerationTerminal`, which answers true for a missing
 * message and for one that is merely interrupted. Both of those are states where the server has
 * nothing better than what is already on screen, so both must NOT lift the veto.
 */
export function serverSnapshotHasAnswer(messages: Message[] | undefined): boolean {
	const lastAssistant = [...(messages ?? [])]
		.reverse()
		.find((message) => message.from === "assistant");
	if (!lastAssistant) return false;
	// `interrupted` is one of the three things isAssistantGenerationTerminal answers true for, and it
	// has to be excluded HERE rather than left to that call: a stopped or cut turn can carry real
	// partial content, which would pass the length check below and lift the veto in favour of a
	// truncated answer. Checked explicitly instead of trusting the terminal helper, because the two
	// functions are asking different questions of the same flag.
	if (lastAssistant.interrupted === true) return false;
	if (!isAssistantGenerationTerminal(lastAssistant)) return false;
	return (lastAssistant.content ?? "").trim().length > 0;
}

/**
 * Whether the conversation page's data-driven `messages` resync may apply.
 *
 * A conversation change (sidebar navigation) always syncs — the destination must paint. A data
 * refresh (invalidation delivering a new `data.messages` identity) applies only when:
 *  - no locally-written turn holds the sync. The hold spans the WHOLE turn — from submit until
 *    the writeMessage finally's post-turn refresh has been OBSERVED to apply (not merely
 *    resolved: a superseded SvelteKit invalidate resolves without applying). This is what
 *    keeps a whole-conversation snapshot swap from orphaning the live stream's write target
 *    (which spills one turn's text into another), and, unlike `pending` (false at the first
 *    token), it covers the full stream plus the stop/terminal-persist window.
 *  - no client-only cache fallback is painted for this conversation (nothing was persisted
 *    server-side; a sync would wipe the painted answer) — UNLESS the snapshot being delivered
 *    actually carries a finished answer, which is `serverSnapshotHasAnswer` above. The veto's
 *    whole purpose is to stop an EMPTY snapshot wiping the optimistic turn, and a snapshot with a
 *    real terminal answer in it is the case it should step aside for. On a deployment where
 *    output screening is the first-token gate, a turn the server completed and persisted reaches
 *    this path with `cacheFallbackHere` set (the client aborts after the last keepalive and the
 *    server persists the answer anyway), and an unconditional veto would leave the page showing
 *    "… is working…" over an answer already in the database.
 *  - no "Report a problem" submission is on screen: the sync re-mints message ids
 *    from the server snapshot, which would destroy and re-create the ReportButton mid-action,
 *    silently discarding its local open/busy/done state before the user ever sees an
 *    acknowledgement. See reportHold.ts.
 *
 * Pure so the page effect's decision is pinnable by tests; the page passes `localTurnSyncHold`
 * as a TRACKED read on purpose (releasing the hold re-runs the effect, which then applies the
 * fresh post-turn snapshot).
 */
export function shouldSyncMessagesFromData(args: {
	convChanged: boolean;
	dataChanged: boolean;
	localTurnSyncHold: boolean;
	cacheFallbackHere: boolean;
	/** `serverSnapshotHasAnswer(data.messages)` for the delivery being decided on. */
	snapshotHasAnswer: boolean;
	reportActionPending: boolean;
}): boolean {
	// The cache-fallback veto is conditional on the snapshot being empty; every other veto is
	// unconditional. Written as its own name rather than inlined so the one asymmetry in this
	// expression is visible at the call site's level of detail.
	const cacheFallbackBlocks = args.cacheFallbackHere && !args.snapshotHasAnswer;
	return (
		args.convChanged ||
		(args.dataChanged &&
			!args.localTurnSyncHold &&
			!cacheFallbackBlocks &&
			!args.reportActionPending)
	);
}

/**
 * After a Stop that came before any of the reply, whether the server's copy of the conversation is
 * missing the turn this tab sent. The server saves the question at the end of a slow
 * pre-stream chain, so a Stop in those seconds reads back a snapshot without it, and syncing to that
 * snapshot blanks the pane. False when it cannot tell (no snapshot read, no id), which keeps the
 * ordinary post-stop refresh.
 */
export function stoppedTurnMissingFromSnapshot(args: {
	firstContentSeen: boolean;
	turnMessageId: string | undefined;
	snapshot: Message[] | undefined;
}): boolean {
	if (args.firstContentSeen || !args.turnMessageId || !args.snapshot) return false;
	return !args.snapshot.some((message) => message.id === args.turnMessageId);
}

/**
 * How long a generation may go without any database write before it is
 * considered dead. Lives in the deadline ladder — it is one rung of a chain the
 * server-side watchdog is clamped against, not a free-standing number. See
 * $lib/chat/utils/deadlineLadder for the full ordering and why it is 180s.
 */
export { GENERATION_STALE_MS };

export function isGenerationStale(lastWriteAt: Date | string | undefined): boolean {
	if (!lastWriteAt) return false;
	const t = new Date(lastWriteAt).getTime();
	return !Number.isNaN(t) && Date.now() - t > GENERATION_STALE_MS;
}

/**
 * What the page's post-first-token "total silence" watchdog should do when its timer fires.
 *
 * The watchdog stays armed for the whole turn, not only until the first content update. Once an
 * agent turn's opening "Working on it…" token has streamed, the client still needs liveness detection
 * for the rest of a turn that can legitimately run past two minutes. `endpointAgent.ts`'s SSE relay
 * pulses a keepalive at least every 4s FOR THE WHOLE TURN because "any inbound update
 * re-arms the watchdog client-side".
 *
 * A connection that dies AFTER that point is a real, observed failure mode: a `fetch()` reader has
 * no way to detect a network-level black hole (a dropped TCP session a proxy/NAT never signals),
 * and the server does not treat client silence as a reason to stop — `conversation/[id]/+server.ts`
 * only flags `clientDetached` when `controller.enqueue()` actually throws, and even then it keeps
 * generating and persists the result regardless (a deliberate resilience feature: a legitimately
 * closed tab must not waste finished work). So the turn can run to completion and save a correct
 * answer while the ORIGINATING tab's `for await` loop sits on an unresolved `reader.read()`
 * forever (server persisted; the sending tab never left
 * "Working on it").
 *
 * The fix is for the watchdog to keep firing on total silence for the WHOLE turn, not just before
 * the first token, and for the caller to branch on which regime it fired in:
 *   - "early-failure": nothing has rendered yet — unchanged pre-existing behavior (try a cached
 *     starter answer, else show a retryable connection-lost message).
 *   - "stall-recovery": content WAS streaming and then went silent for the full window — the
 *     connection was live and died, so unlike "early-failure" there may already be a complete,
 *     correctly-saved answer sitting server-side. The caller aborts its own dead connection and
 *     hands the conversation to the background-generation poller (which already exists for "a
 *     generation this tab isn't actively streaming anymore") instead of inventing an error over a
 *     turn that might already be finished.
 *   - "ignore": the turn already ended by some other path (a user Stop, a navigation abort) — the
 *     watchdog firing here is a harmless race, not a new event.
 */
export type WatchdogFireOutcome = "ignore" | "early-failure" | "stall-recovery";

export function classifyWatchdogFire(args: {
	firstContentSeen: boolean;
	isAborted: boolean;
}): WatchdogFireOutcome {
	if (args.isAborted) return "ignore";
	return args.firstContentSeen ? "stall-recovery" : "early-failure";
}

/**
 * whether a stream that ENDED without throwing still left the turn unanswered, so the page
 * should hand it to the background-generation poller the way a stall does.
 *
 * @remarks iOS closes a fetch body cleanly when the phone locks or the visitor switches apps, and a
 * venue Wi-Fi drop can do the same: the read resolves `done` with content on screen and no
 * FinalAnswer. No watchdog fires and nothing throws, so before this the turn ended as `incomplete`
 * with half an answer while the server went on to finish and save the whole one. Every other way the
 * turn can have ended (an answer, a Stop, a refusal, an error, a watchdog path, a reattach) already
 * has its own handling, and each of them rules this out.
 */
export function streamClosedBeforeAnswer(args: {
	firstContentSeen: boolean;
	finalAnswerSeen: boolean;
	isAborted: boolean;
	stopRequested: boolean;
	requestRefused: boolean;
	turnErrored: boolean;
	watchdogFired: boolean;
}): boolean {
	return (
		args.firstContentSeen &&
		!args.finalAnswerSeen &&
		!args.isAborted &&
		!args.stopRequested &&
		!args.requestRefused &&
		!args.turnErrored &&
		!args.watchdogFired
	);
}

/**
 * What the silence watchdog tells its caller when it fires.
 *
 * @remarks `hiddenMs` is how long the page was hidden inside the silence that fired it. More than zero
 * means the silence spanned a lock or an app switch, which is the usual reason a phone's fetch dies,
 * so the caller can log that outcome as its own instead of as a dead connection.
 */
export type SilenceWatchdogFire = { hiddenMs: number };

/**
 * The silence watchdog: fire `onFire` after `timeoutMs` of silence the visitor could see.
 *
 * @remarks Hidden time does not count. While `document.visibilityState` is hidden the timer
 * is paused; when the page shows again it resumes with whatever was left of the window when it hid.
 * A phone that locks for twenty seconds mid-answer therefore comes back to a live watchdog with its
 * remaining budget, not to an instant fire that labels the turn a dead connection. If the stream is
 * still alive its next update re-arms the watchdog; if it died while hidden, the watchdog fires once
 * that remaining visible budget has run out, and reports the hidden time so the caller can say so.
 *
 * This also covers the case, a backgrounded tab whose throttled timer sits queued past
 * `timeoutMs`: no timer runs while the page is hidden, and the one that resumes on return is an
 * ordinary foreground timer.
 *
 * `hiddenMs` and `returnedFromHidden` report the whole life of the watchdog, across re-arms, for
 * the turn's terminal telemetry.
 */
export function armSilenceWatchdog(opts: {
	timeoutMs: number;
	onFire: (fire: SilenceWatchdogFire) => void;
	/** Injectable for tests; defaults to the real clock. */
	now?: () => number;
}): {
	rearm: () => void;
	dispose: () => void;
	hiddenMs: () => number;
	returnedFromHidden: () => boolean;
} {
	const { timeoutMs, onFire, now = Date.now } = opts;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const isHidden = () => document.visibilityState === "hidden";
	// The current silence window: visible time already spent in it, when the current visible stretch
	// began, and the hidden time inside it.
	let visibleSpentMs = 0;
	let visibleSince = now();
	let windowHiddenMs = 0;
	// Set while the page is hidden.
	let hiddenSince: number | undefined = isHidden() ? now() : undefined;
	// The whole life of the watchdog, across re-arms.
	let totalHiddenMs = 0;
	let returned = false;
	let disposed = false;

	const clearTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const fire = () => {
		clearTimer();
		if (disposed) return;
		onFire({ hiddenMs: windowHiddenMs });
	};

	const startTimer = (ms: number) => {
		clearTimer();
		if (ms <= 0) fire();
		else timer = setTimeout(fire, ms);
	};

	const onVisibilityChange = () => {
		const at = now();
		if (isHidden()) {
			if (hiddenSince !== undefined) return;
			clearTimer();
			visibleSpentMs += at - visibleSince;
			hiddenSince = at;
			return;
		}
		if (hiddenSince === undefined) return;
		const hiddenFor = at - hiddenSince;
		hiddenSince = undefined;
		windowHiddenMs += hiddenFor;
		totalHiddenMs += hiddenFor;
		returned = true;
		visibleSince = at;
		startTimer(timeoutMs - visibleSpentMs);
	};
	document.addEventListener("visibilitychange", onVisibilityChange);

	const rearm = () => {
		const at = now();
		visibleSpentMs = 0;
		windowHiddenMs = 0;
		visibleSince = at;
		if (hiddenSince !== undefined) {
			// An update arrived while hidden (a desktop tab keeps streaming): the window restarts, still paused.
			totalHiddenMs += at - hiddenSince;
			hiddenSince = at;
			clearTimer();
			return;
		}
		startTimer(timeoutMs);
	};
	rearm();

	const dispose = () => {
		disposed = true;
		clearTimer();
		document.removeEventListener("visibilitychange", onVisibilityChange);
	};

	return {
		rearm,
		dispose,
		hiddenMs: () => totalHiddenMs + (hiddenSince !== undefined ? now() - hiddenSince : 0),
		returnedFromHidden: () => returned,
	};
}

/**
 * Should the "No answer was produced for this message." notice render?
 *
 * `producedNoAnswer` answers "did a FINISHED turn leave the user with anything", and establishing
 * FINISHED is this function's whole job. `loading` alone is not the same fact: it is the parent's
 * live-stream boolean and it goes false when the fetch settles, which is milliseconds-to-seconds
 * before the final content is applied to `blocks`. In that gap the message's own state machine
 * still says `running` while the block list is still empty, so gating on `loading` alone fires the
 * notice on every turn that is about to answer, for as long as its time-to-answer (up to a few
 * seconds). LiveRequestLog gates on `loading || status === 'running'` (ChatMessage.svelte), so
 * without this check the two surfaces disagree about whether the same turn is over and both render.
 *
 * A turn that reasons at length and then FINISHES empty still gets the notice: a
 * FinalAnswer update arrived, the status is `complete`, and the notice fires over its empty body. What
 * this defers is the never-terminal case — a stream that dies with no terminal update now shows a
 * blank bubble until something makes it terminal. That is deliberate and it is already owned: the
 * server marks such a turn interrupted, and `updates/+server.ts` closes it out on
 * `isAssistantGenerationTerminal(lastAssistant) || isGenerationStale(conv.updatedAt)`. Deferring to
 * that is right — announcing "no answer was produced" about a turn still producing one is a false
 * statement, and it is the statement a first-time visitor reads as the model being broken.
 */
export function shouldShowEmptyAnswerNotice(args: {
	message: Message | undefined;
	/** True when nothing renderable survived — pass `producedNoAnswer(blocks, fileCount)`. */
	noAnswer: boolean;
	/** The parent's live-stream flag. */
	loading: boolean;
}): boolean {
	const { message, noAnswer, loading } = args;
	if (loading) return false;
	if (!message || message.from !== "assistant") return false;
	const status = deriveMessageStatus(message);
	// `running` is not a verdict yet; `error` renders its own failure surface and must not stack.
	if (status === "running" || status === "error") return false;
	return noAnswer;
}

/**
 * Should the collapsed provenance RECEIPT render — the trace, the brand line, and the
 * "No provenance for this answer" statement that stands in for them?
 *
 * Two independent questions, and both have to be yes. `showsLiveProvenanceTrace` answers whether
 * this message HAS live provenance to show at all (a cache-served turn never ran the live
 * pipeline, so a trace asserting one would be a claim about a request that never happened). This
 * function adds the second: whether the
 * turn is OVER, which is the same "has it finished" problem `shouldShowEmptyAnswerNotice` above
 * documents at length, reached from the other direction.
 *
 * Bare `!loading` is not the same fact: `loading` goes false when the client fetch settles, a beat
 * (up to a few seconds) before the final content lands. In that gap the message's own state machine
 * still says `running`, so gating on `!loading` renders the `{:else}` branch, the one that says
 * nothing reported which model served this answer, WHILE the answer is being served, and then
 * replaces it with the full provenance line a moment later. That contradicts the product's own
 * claim about where Alpha runs and who runs it.
 *
 * Deliberately strictly later than bare `!loading` and never earlier: this block cannot appear
 * before a turn is genuinely finished. The live phases during a turn are LiveRequestLog's job, and
 * it already gates on this same predicate.
 */
export function showsProvenanceReceipt(args: {
	message: Message;
	/** The parent's live-stream flag. */
	loading: boolean;
}): boolean {
	return showsLiveProvenanceTrace(args.message) && !isTurnStillRunning(args.loading, args.message);
}

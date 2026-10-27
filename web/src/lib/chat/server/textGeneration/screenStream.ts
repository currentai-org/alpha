import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";
import {
	screenModelOutput,
	OUTPUT_CONTENT_DECLINE,
	OUTPUT_CHILD_SAFETY_DECLINE,
	OUTPUT_CONTENT_TRUNCATE,
	OUTPUT_CHILD_SAFETY_TRUNCATE,
	OUTPUT_UNSCREENED_DECLINE,
	OUTPUT_UNSCREENED_TRUNCATE,
	type OutputScreenResult,
} from "$lib/chat/server/moderation";
import { resolveActionLabel, resolveActionMessage } from "$lib/chat/server/ruleLabel";
import type { DeclineLanguage } from "$lib/chat/server/declineCopy";
import { logger } from "$lib/chat/server/logger.js";
import type { TurnSpans } from "$lib/chat/types/MessageTimings";
import { stripThink } from "$lib/chat/server/stripThink";
import type { OutputRecheck } from "$lib/chat/server/outputRecheck";

// ── Chunked streaming OUTPUT moderation (hold-and-release, grouped + pipelined) ─────────────────
// The shape follows NVIDIA NeMo Guardrails' streaming output rails: instead of suppressing the
// whole answer and screening it once (no streaming, the user waits blind), screen the model's output
// in small batches and release each batch only AFTER it clears. Exposure is bounded to ZERO
// unscreened bytes — we never emit a chunk the moderator hasn't passed — while the answer still
// streams (batch-granular "faux streaming": each cleared batch appears when it's cleared).
//
// Why sentences, not tokens: Coop's /content is a per-item synchronous classifier (~1s/call), so a
// per-token gate is infeasible; a sentence (~15-40 tokens) is the natural PRIMITIVE grain (nextChunk).
// Screening every sentence separately means N Coop round trips for an N-sentence answer, and awaiting
// each one before even DISPATCHING the next stacks that latency serially. Two things cut that tax:
//   • GROUPING: only the very first batch stays sentence-sized (fast TTFT — see FIRST_CHUNK_CHARS).
//     Every batch after accumulates consecutive sentences until MIN_CHUNK_CHARS (a paragraph break also
//     forces an earlier flush, to keep structural boundaries clean) — roughly halving-to-thirding N for
//     a typical multi-sentence answer. Trade-off: on a SLOW generation (long pauses between sentences),
//     grouping delays a sentence that's ready until its batch-mates arrive too — acceptable because the
//     tax this change targets is Coop-bound, not generation-bound.
//   • PIPELINING: a batch no longer waits for the PRIOR batch's Coop verdict before firing — only for
//     its TEXT, which is already known from generation. Up to PIPELINE_DEPTH Coop calls run
//     concurrently; results are still RELEASED to the client strictly in order, and the moment an
//     earlier batch blocks, any later speculative results are discarded before release — never released
//     past a block, never out of order. Each screen still carries a prior-text context prefix so a
//     payload split across a batch boundary ("how to make a b" / "omb") is still caught (NeMo's sliding
//     window); the context is built from the RAW generated text of everything assigned so far
//     (confirmed clean or not) — safe, because a speculative batch's context can only make screening
//     MORE conservative, and its result is discarded entirely if an earlier batch in the window blocks.
//
// Generation OVERLAPS grouping and screening: a background producer keeps pulling tokens while the
// consumer accumulates/screens, so later batches are usually already buffered by the time an earlier
// screen returns — no inter-batch stall waiting on the next sentence to generate.
//
// Honesty: NO Safety event is emitted (that field is the INPUT-decline marker and would mis-frame an
// output block as an input decline). The block is conveyed by the decline/notice TEXT and by stamping
// message.outputModeration (via onModeration) — the request-trace's "Output screen" step reads that.

const MAX_CHUNK_CHARS = 400; // force a screen even without sentence punctuation (code blocks, long lists)
const CONTEXT_CHARS = 200; // prior-text context included in each screen (cross-chunk evasion guard)
// First-chunk fast path (TTFT): before ANY content has been released, force the first screen at a much
// smaller char cap so first visible content lands sooner when the model opens with a long unpunctuated
// preamble. A normal short first sentence still flushes at its terminator (this cap never fires for it),
// so this only helps the pathological long-first-sentence case — cheap, and never delays a fast opener.
const FIRST_CHUNK_CHARS = 120;
// Steady-state grouping (every batch AFTER the first): keep accumulating complete sentences until this
// many chars have built up (or a paragraph break forces an earlier flush) before issuing one Coop call
// for the whole group. Cuts a typical multi-sentence answer's Coop-call count roughly in half or more.
const MIN_CHUNK_CHARS = 250;
// Up to this many Coop screens run concurrently (order-preserving release, discard-on-block — see the
// header comment). Bounded so a burst of short sentences can't fan out unboundedly.
const PIPELINE_DEPTH = 3;

// Idle bound on the screening phase: the longest it may go without releasing a batch. Distinct from
// COOP_TIMEOUT_MS, which only bounds one Coop call (moderation.ts), and from the route's own 45s total
// cap (genTimeoutMs), which still bounds the whole turn. As a total-phase bound it would cut healthy
// long answers (a slow model generates for tens of seconds, with only a few seconds of that in Coop), so it re-arms on every release (CUR-1884).
// A turn can die at the outer 45s generation watchdog with firstTokenReached=false while every
// individual screen call is fast (screenPhaseMs can run far beyond any single call's abort clamp).
// The stall is load-correlated and sits downstream of the per-call bound, so a per-call
// timeout alone does not catch it (CUR-1657). This is the backstop: whatever kept a nested promise
// from settling, the phase cannot sit without progress past this deadline. On trip, release whatever
// already cleared (or decline honestly) instead of leaving the user with nothing until the 45s
// watchdog fires. Sized with real margin under genTimeoutMs (45_000, +server.ts) and well above the
// healthy p90 (11,582ms) so it does not fire on a legitimately slow-but-working turn.
const PHASE_DEADLINE_MS = Number(process.env.OUTPUT_SCREEN_PHASE_TIMEOUT_MS) || 25_000;

// Honest, non-safety copy for a phase-deadline trip: an infra bound firing, with no verdict behind it,
// so it must never borrow OUTPUT_CONTENT_DECLINE/_TRUNCATE's wording — that copy is reviewed safety copy
// and implies Coop actually flagged something, which did not happen here.
// Bound on the FINALLY-block cleanup (it.return() + draining the producer), separate from
// PHASE_DEADLINE_MS. it.return() QUEUES behind an already in-flight it.next() on the same async
// iterator and cannot preempt one that never settles — precisely the case the phase deadline exists
// for (CUR-1657, confirmed by screenStream.spec.ts's own phase-deadline tests: without this bound,
// cleanup itself hangs forever and the honest decline this file exists to deliver never reaches the
// user). Best-effort past this point — bounded, not skipped, so a healthy upstream still gets a clean
// it.return() almost every time.
const CLEANUP_DEADLINE_MS = 2_000;

const OUTPUT_SCREEN_TIMEOUT_DECLINE =
	"I started to answer, but couldn't finish verifying the response in time, so I've held it back. Please try again.";
const OUTPUT_SCREEN_TIMEOUT_TRUNCATE =
	"_[The rest of this response couldn't be verified in time and was withheld.]_";
// OUTPUT_SCREEN_TIMEOUT_DECLINE asserts generation started ("I started to answer") — true
// when the phase deadline trips after real tokens arrived but before the tail cleared screening, false
// when NO token ever arrived (a sovereignty shed upstream — CUR-1313 — that produced zero tokens is
// the observed case). Same honest, non-safety register as the sibling copy; narrower claim. Matches the
// wording of the admission-gate's own at-capacity notice (+server.ts's pre-accept 503 path) rather than
// inventing a third phrasing for the same user-facing idea. (CUR-1727)
const OUTPUT_SCREEN_NO_TOKENS_DECLINE = "Alpha is at capacity right now. Please try again in a moment.";

/** The marker stamped onto message.outputModeration (shape mirrors Message.ts). */
export interface OutputModerationMarker {
	flagged: boolean;
	label: string | null;
	score: number;
	kind: "child_safety" | "content_policy";
	screened: boolean;
	/** true = a clean prefix was already shown and the REST was withheld (mid-stream truncation). */
	truncated?: boolean;
	/** Curated public-safe rule name (resolved server-side from the blocking action). Present only when
	 *  the rule has a reviewed label; the raw action code never reaches the client. */
	ruleLabel?: string;
	/** true = the guard could not answer, so the answer was withheld unchecked, not flagged (CUR-3891). */
	unscreened?: boolean;
	/** How many flagged batches the re-check released (CUR-3975). Absent when none. */
	rechecked?: number;
}

export type ScreenFn = (text: string, userId?: string) => Promise<OutputScreenResult>;

/** Route-owned ledger of every output screen fired this turn (coop-review-plane Step 3c). The route's
 *  finalizer drains `dispatched` for the ONE output review report and flips `stopped` to make
 *  finalization a TERMINAL BOUNDARY — once stopped, this generator screens nothing more, releases
 *  nothing more, and persists nothing more. The generator only APPENDS here (dispatched + released) and
 *  reads `stopped`; it never collects results or reports. Created pre-stream by the route so a cancel
 *  during the prestream phase can stop it before the pipeline ever reads it. */
export interface OutputScreenLedgerEntry {
	promise: Promise<OutputScreenResult>;
	text: string;
	/** Set true the moment this batch is released to the client — so the finalizer appends only
	 *  fired-but-UNRELEASED batch text to the report (a repeated batch is never deduped by substring). */
	released: boolean;
}

export interface OutputScreenLedger {
	/** Every screen ever fired, in order — the finalizer awaits these for the report. */
	dispatched: OutputScreenLedgerEntry[];
	/** Set by the route's finalizer; the generator refuses to screen or release once true. */
	stopped: boolean;
	/** The raw text released to the client so far — the report's release context. */
	released: string;
}

export interface ScreenStreamOptions {
	userId?: string;
	signal?: AbortSignal;
	/** Stamp the output-screen verdict onto the message (clear OR blocked) for the trace + persistence. */
	onModeration?: (marker: OutputModerationMarker) => void;
	/** Injectable for tests; defaults to the real Coop-backed screen. */
	screen?: ScreenFn;
	/** The language the person wrote in, so a rule's decline notice reads in it (CUR-4051). English
	 *  when absent. Awaited only when an answer is cut. */
	declineLanguage?: Promise<DeclineLanguage>;
	/** Optional per-turn timing sink; the output-screen decomposition
	 *  (firstScreenMs/totalScreenMs/screenPhaseMs) is written here for durable persistence. */
	timings?: TurnSpans;
	/** The route's output-screen ledger (coop-review-plane Step 3c). Every screen goes through it; the
	 *  route drains it for the ONE output report and flips `stopped` at finalization. */
	ledger?: OutputScreenLedger;
	/** Overrides PHASE_DEADLINE_MS for this turn. Set only by the route's `output_screen_window_short`
	 *  fault (faultInjection.ts). */
	phaseDeadlineMs?: number;
	/** Bounds the wait for the FIRST token, which ordinarily has no bound here (CUR-2243: the route's
	 *  watchdogs own it). Set only by the route's `output_screen_timeout` fault, so a spec reaches the
	 *  no-token decline in a second. */
	preTokenDeadlineMs?: number;
	/** Agent turns only (CUR-546). A non-content event re-arms the phase deadline while no screen is in
	 *  flight. The agent works silently for longer than the window and pulses a keepalive every 4s
	 *  (endpointAgent.ts HEARTBEAT_MS) so the turn is not read as dead; without this the window counted
	 *  only releases and declined every agent turn that worked for more than 25s. A screen that never
	 *  settles still trips the deadline, because a keepalive re-arms nothing while one is pending. */
	rearmOnProgress?: boolean;
	/** Asked about a flagged batch before the answer is cut, with the answer before it and the time the
	 *  window has left (CUR-3975). Its result replaces the batch's verdict, so it can release a batch the
	 *  narrow screen flagged. */
	recheck?: OutputRecheck;
}

/**
 * First COMPLETE chunk at the front of `buffer`, or null if more tokens are needed. A chunk ends at:
 * a sentence terminator (.!? + optional closing quote/bracket + whitespace), a paragraph break, or
 * MAX_CHUNK_CHARS (cut at the last whitespace to avoid splitting mid-word). Returns a PREFIX of buffer.
 */
export function nextChunk(buffer: string, maxChars: number = MAX_CHUNK_CHARS): string | null {
	if (!buffer) return null;

	let end = -1;
	const sentence = /[.!?]+["'’”)\]]*\s/.exec(buffer);
	if (sentence) end = sentence.index + sentence[0].length;

	const para = buffer.indexOf("\n\n");
	if (para !== -1) {
		const paraEnd = para + 2;
		end = end === -1 ? paraEnd : Math.min(end, paraEnd);
	}

	if (end !== -1) return buffer.slice(0, end);

	if (buffer.length >= maxChars) {
		const slice = buffer.slice(0, maxChars);
		const lastWs = slice.lastIndexOf(" ");
		return lastWs > maxChars * 0.5 ? slice.slice(0, lastWs + 1) : slice;
	}
	return null;
}

/**
 * Wrap a text-generation event stream with sentence-by-sentence output screening. Yields cleared
 * chunks as Stream events, passes non-content events through, and ends with a single FinalAnswer
 * carrying the released text (or a decline / prefix+notice on a block). Never yields an unscreened token.
 */
export async function* screenOutputStream(
	source: AsyncIterable<MessageUpdate>,
	opts: ScreenStreamOptions
): AsyncGenerator<MessageUpdate> {
	const screen = opts.screen ?? screenModelOutput;
	const { userId, signal, ledger } = opts;

	let buffer = ""; // accumulated, not-yet-batched tokens (the producer appends; the consumer drains)
	// True the moment the upstream source yields its first real token. Deliberately NOT
	// `screenCount > 0` — screenChunk only increments that after its `screen()` call RESOLVES, so a
	// dispatched-but-still-pending screen (the ordinary phase-deadline case) also reads screenCount 0.
	// This is the honest "did anything ever arrive to answer with" signal a zero-token shed needs. (CUR-1727)
	let anyTokenArrived = false;
	let released = ""; // cleared text already yielded (also the final FinalAnswer body + context source)
	let blocked = false;
	let blockedKind: "child_safety" | "content_policy" = "content_policy";
	// The blocking Coop action (rule identity) — captured so the marker can carry a curated public label.
	// Server-side only; resolved to a label below and never emitted raw.
	let blockedCategory: string | undefined;
	// The block was a child screen that never answered, not a detection (CUR-3891).
	let blockedUnscreened = false;
	let finalInterrupted = false;
	// Held for the same reason as finalInterrupted: this function throws away the upstream FinalAnswer's
	// TEXT and composes its own body from `released`, so a truncation notice written into that text would
	// be silently dropped. The flag survives; the notice is appended once downstream (CUR-149).
	let finalTruncated = false;

	// Instrumentation (mirror of the input-gate "[moderation] pre-model screen timing"): firstScreenMs
	// is the output-side TTFT contributor (the opening batch can't be released until it clears);
	// totalScreenMs sums each call's OWN duration (per-call latency, but no longer a wall-clock proxy now
	// that calls overlap); screenPhaseMs is the actual wall-clock span of the whole screening phase — the
	// number grouping+pipelining should shrink.
	let firstScreenMs = 0;
	let totalScreenMs = 0;
	let screenCount = 0;
	// Re-checks of flagged batches (CUR-3975): how many ran, how many released their batch, their time.
	let recheckCount = 0;
	let recheckCleared = 0;
	let recheckMs = 0;
	const screenPhaseStart = performance.now();

	// A single top-level timer, independent of any per-call AbortSignal, so the phase cannot sit without
	// progress past it even when a nested promise (a Coop fetch, an upstream iterator pull) never settles
	// for a reason the per-call bound doesn't catch. Re-armed on every release (CUR-1884), so it bounds
	// the gap between releases, not the whole answer. `unref` keeps it from holding the process open
	// past a normal exit.
	//
	// The window opens at the model's first token, not when this phase starts (CUR-2243). Counted from
	// the start, it declines turns from a slow-to-start lane that has not produced a token in 25s but
	// would answer later (CUR-2243). Before the first token
	// the route's own watchdogs bound the wait (SILENCE_TIMEOUT_MS / genTimeoutMs), and a hang there
	// ends as the route's timeout, not as a screening decline. preTokenWaitMs is logged and persisted
	// so the time before the window opened stays visible next to screenPhaseMs.
	let phaseDeadlineHit = false;
	let phaseDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let resolvePhaseDeadline!: () => void;
	const phaseDeadline = new Promise<void>((resolve) => (resolvePhaseDeadline = resolve));
	const deadlineMs = opts.phaseDeadlineMs ?? PHASE_DEADLINE_MS;
	type ArmReason = "pre_token" | "first_token" | "release" | "failover" | "keepalive";
	let windowOpen = false;
	let preTokenWaitMs: number | undefined;
	let lastArmedAt = screenPhaseStart;
	let lastArmReason: ArmReason = "pre_token";
	const armPhaseDeadline = (reason: ArmReason, ms: number = deadlineMs) => {
		clearTimeout(phaseDeadlineTimer);
		lastArmedAt = performance.now();
		lastArmReason = reason;
		phaseDeadlineTimer = setTimeout(() => {
			phaseDeadlineHit = true;
			logger.warn(
				{
					windowMs: ms,
					lastArmReason,
					sinceLastArmMs: Math.round(performance.now() - lastArmedAt),
					phaseElapsedMs: Math.round(performance.now() - screenPhaseStart),
					preTokenWaitMs,
					anyTokenArrived,
					screensInFlight: unsettledScreens,
					releasedLen: released.length,
				},
				"[moderation] output screen window expired"
			);
			resolvePhaseDeadline();
		}, ms);
		phaseDeadlineTimer.unref?.();
	};
	const openWindow = () => {
		if (windowOpen || phaseDeadlineHit) return;
		windowOpen = true;
		preTokenWaitMs = Math.round(performance.now() - screenPhaseStart);
		armPhaseDeadline("first_token");
	};
	// Only the output_screen_timeout fault bounds the wait before the first token (see the option).
	if (opts.preTokenDeadlineMs !== undefined) armPhaseDeadline("pre_token", opts.preTokenDeadlineMs);

	// Screen `text` (a batch — see below) behind the last CONTEXT_CHARS of `prior`, all the answer text
	// assigned before it. Whitespace-only batches need no Coop call — release them as-is. A flagged batch
	// goes to the re-check, when there is one, with the whole of `prior` in front of it.
	const screenChunk = async (text: string, prior: string): Promise<OutputScreenResult> => {
		if (!text.trim()) return { blocked: false, kind: null };
		const t0 = performance.now();
		const res = await screen(prior.slice(-CONTEXT_CHARS) + text, userId);
		const ms = performance.now() - t0;
		screenCount += 1;
		totalScreenMs += ms;
		if (screenCount === 1) firstScreenMs = ms;
		if (!res.blocked || !opts.recheck) return res;
		// The re-check runs only inside the window, never after it ran out or finalization began, so it
		// cannot hold a flagged batch past the deadline the screen already answers to.
		const windowLeftMs = Math.floor(deadlineMs - (performance.now() - lastArmedAt));
		if (ledger?.stopped || phaseDeadlineHit || windowLeftMs <= 0) return res;
		const r0 = performance.now();
		const rechecked = await opts.recheck(prior, text, res, windowLeftMs);
		recheckCount += 1;
		recheckMs += performance.now() - r0;
		if (!rechecked.blocked) recheckCleared += 1;
		return rechecked;
	};

	// Screens dispatched whose promise has not settled. Counted here rather than read off
	// `pipeline`, because the consumer shifts a screen off `pipeline` before awaiting its verdict. (CUR-546)
	let unsettledScreens = 0;

	// EVERY screen goes through dispatch — it records the screen on the route's
	// ledger so the finalizer can drain it for the ONE output report, and REFUSES once the route has begun
	// finalizing (ledger.stopped). A null return means "do not screen, do not release" — the caller drops
	// that text. Without a ledger (a standalone caller) it behaves exactly as a direct screenChunk.
	const dispatch = (text: string, prior: string): OutputScreenLedgerEntry | null => {
		if (ledger?.stopped) return null;
		const entry: OutputScreenLedgerEntry = { promise: screenChunk(text, prior), text, released: false };
		unsettledScreens += 1;
		void entry.promise.then(
			() => (unsettledScreens -= 1),
			() => (unsettledScreens -= 1)
		);
		ledger?.dispatched.push(entry);
		return entry;
	};

	// ── Producer: drain the model stream CONCURRENTLY with screening ─────────────────────────────────
	// While the consumer's pipeline awaits Coop screens, this keeps pulling tokens so later batches are
	// already buffered when a screen returns — no inter-batch stall waiting on the next sentence to
	// generate. Non-content events queue for prompt pass-through (they re-arm the client's first-token
	// watchdog during a slow cold start).
	const passthrough: MessageUpdate[] = [];
	// A read-aloud clip is synthesized from the model's whole answer, unscreened text
	// included, and the client stores and plays whatever clip arrives. So clips wait here for the
	// answer's verdict: released after a cleared answer's text, dropped on any other ending. (CUR-3847)
	const heldClips: MessageUpdate[] = [];
	// Typed by assertion so the producer closure sees the whole union, not the "pending" initializer.
	let clipVerdict = "pending" as "pending" | "release" | "drop";
	const isClip = (e: MessageUpdate) => e.type === MessageUpdateType.Mcp && Boolean(e.audio);
	let sourceDone = false;
	// Upstream's own FinalAnswer, which marks the end of CONTENT (CUR-1907). The source can keep going
	// after it: textGeneration merges the title generator in, so a new conversation's Title event lands
	// after the model has finished. Waiting for sourceDone before screening the tail would hold a short
	// answer's last sentence behind the title call, up to its 15s ceiling.
	let contentDone = false;
	// The upstream source (the model call, agent-service's fetch, whatever textGeneration
	// wraps) can throw mid-pull. Captured here rather than left to reject the `producer` promise,
	// because a rejection there would be silently discarded while the `finally` still marked
	// sourceDone — the consumer would read a mid-stream throw exactly like a clean end-of-stream
	// and this generator would fall through to composing an empty FinalAnswer as if nothing was wrong. Checked
	// once the consume loop notices sourceDone, and re-thrown — see the `if (producerError)` below. (CUR-782)
	let producerError: unknown;
	const it = source[Symbol.asyncIterator]();
	// A "something changed" signal so the consumer can sleep until new tokens/events arrive (vs spinning).
	let wake!: () => void;
	let wakeP = new Promise<void>((r) => (wake = r));
	const bump = () => {
		const w = wake;
		wakeP = new Promise<void>((r) => (wake = r));
		w();
	};

	const producer = (async () => {
		try {
			for (;;) {
				if (signal?.aborted) break;
				if (ledger?.stopped) break; // finalization began — stop pulling tokens (coop-review-plane Step 3c)
				const { value: event, done } = await it.next();
				if (done) break;
				// Abort may fire DURING it.next() (upstream cancellation). Discard the post-abort value so
				// the buffer only ever holds pre-abort tokens — the consumer can then safely drain whatever
				// is buffered without releasing anything generated after the user aborted.
				if (signal?.aborted) break;
				if (event.type === MessageUpdateType.FinalAnswer) {
					// Hold it — we compose our own FinalAnswer once the tail is screened. Keep the flags.
					// A producer that streamed nothing and composed its answer whole (the explicit
					// read-aloud path suppresses every Stream token) has its text only here. Screen it like
					// streamed text; composing from the empty buffer turned an answered turn into "No output
					// was generated". Only when nothing streamed, so a streamed answer is never screened twice. (CUR-2045)
					if (!anyTokenArrived && event.text.trim()) {
						buffer += event.text;
						anyTokenArrived = true;
						openWindow();
					}
					finalInterrupted = event.interrupted;
					finalTruncated = Boolean(event.truncated);
					contentDone = true;
					bump();
					continue;
				}
				if (event.type === MessageUpdateType.Stream) {
					buffer += event.token;
					anyTokenArrived = true;
					openWindow();
				} else if (isClip(event) && clipVerdict !== "release") {
					if (clipVerdict === "pending") heldClips.push(event);
				} else {
					passthrough.push(event);
					// See rearmOnProgress. (CUR-546)
					if (opts.rearmOnProgress && windowOpen && unsettledScreens === 0 && !phaseDeadlineHit)
						armPhaseDeadline("keepalive");
				}
				// A switch to the backup lane is progress. Without this the backup inherits whatever
				// is left of the window the silent primary spent, 13s after a 12s failover deadline, which a
				// reasoning backup can use up before its first sentence clears the screen.
				// Only once the window is open: before the first token there is no window to inherit (CUR-2243). (CUR-2316)
				if (event.type === MessageUpdateType.Failover && windowOpen && !phaseDeadlineHit) armPhaseDeadline("failover");
				bump();
			}
		} catch (err) {
			producerError = err;
		} finally {
			sourceDone = true;
			bump();
		}
	})();

	// ── Batching: group consecutive primitive chunks (nextChunk) into one screening unit ─────────────
	// The first batch stays a single small primitive chunk (FIRST_CHUNK_CHARS, fast TTFT). Every batch
	// after accumulates primitive chunks until MIN_CHUNK_CHARS, or an earlier paragraph-break flush.
	// Returns null when there isn't (yet) a complete batch — more producer input is needed.
	let firstBatchTaken = false;
	let pendingBatch = ""; // primitive chunks accumulated but not yet flushed as a full batch
	const tryTakeBatch = (): string | null => {
		if (!firstBatchTaken) {
			const c = nextChunk(buffer, FIRST_CHUNK_CHARS);
			if (c === null) return null;
			buffer = buffer.slice(c.length);
			firstBatchTaken = true;
			return c;
		}
		let acc = pendingBatch;
		for (;;) {
			const c = nextChunk(buffer, MAX_CHUNK_CHARS);
			if (c === null) break;
			buffer = buffer.slice(c.length);
			acc += c;
			if (acc.length >= MIN_CHUNK_CHARS || c.endsWith("\n\n")) {
				pendingBatch = "";
				return acc;
			}
		}
		pendingBatch = acc;
		return null;
	};

	// ── Pipeline: up to PIPELINE_DEPTH Coop screens in flight, released strictly in order ────────────
	// A batch's Coop call fires as soon as it's assigned — it does NOT wait for an earlier batch's
	// verdict, only for its own text (already known from generation). `rawTail` tracks released + every
	// batch's raw text assigned so far (confirmed clean or not) so context stays correct even for
	// speculative batches; see the header comment for why that's safe.
	const pipeline: OutputScreenLedgerEntry[] = [];
	let rawTail = "";
	const fireNext = () => {
		while (pipeline.length < PIPELINE_DEPTH) {
			if (ledger?.stopped) break; // finalization began — screen nothing more
			const batch = tryTakeBatch();
			if (batch === null) break;
			const prior = rawTail;
			rawTail += batch;
			// A whitespace-only batch still goes through dispatch (screenChunk short-circuits it to a clean
			// resolved result), so the ledger and the stopped boundary cover every batch uniformly.
			const entry = dispatch(batch, prior);
			if (entry === null) break; // stopped between the check and here
			pipeline.push(entry);
		}
	};

	// Leaving early (block/abort/phase-deadline) → tell the upstream model to stop; don't keep
	// generating unseen tokens. Bounded (CUR-1657): it.return() queues behind an already in-flight
	// it.next() and cannot preempt one that never settles, and the producer's own try/catch (above)
	// means nothing here needs to swallow a throw from it — so both are safe to abandon past
	// CLEANUP_DEADLINE_MS rather than hold the user's response hostage to upstream cleanup.
	const cleanupSource = async () => {
		const cleanup = (async () => {
			await it.return?.();
			await producer;
		})();
		const cleanupTimedOut = await Promise.race([
			cleanup.then(() => false as const),
			new Promise<true>((resolve) => {
				const t = setTimeout(() => resolve(true), CLEANUP_DEADLINE_MS);
				t.unref?.();
			}),
		]);
		if (cleanupTimedOut) {
			logger.warn(
				{ phaseDeadlineHit },
				"[moderation] output screen cleanup did not settle in time — abandoning it.return()"
			);
			cleanup.catch(() => {}); // never let the abandoned chain surface as an unhandled rejection later
		}
	};
	let deferCleanup = false;
	const aborted$ = new Promise<void>((resolve) => {
		if (signal?.aborted) resolve();
		else signal?.addEventListener("abort", () => resolve(), { once: true });
	});
	// After our FinalAnswer, pass through whatever the source still sends (the Title event)
	// until it ends. Runs only when the consumer's finally deferred the source's cleanup; an abort, or
	// the caller abandoning this generator, cancels the source the same bounded way as leaving early. (CUR-1907)
	function dropClips() {
		clipVerdict = "drop";
		heldClips.length = 0;
	}
	async function* drainAfterContent(): AsyncGenerator<MessageUpdate> {
		if (!deferCleanup) return;
		try {
			for (;;) {
				while (passthrough.length) {
					const ev = passthrough.shift();
					if (ev) yield ev;
				}
				if (sourceDone || signal?.aborted) break;
				await Promise.race([wakeP, aborted$]);
			}
		} finally {
			if (!sourceDone) await cleanupSource();
		}
	}

	// ── Consumer: keep the pipeline topped up, release cleared batches strictly in order ─────────────
	// Drains the buffer (which holds only pre-abort, generated tokens); the abort check fires only once
	// the pipeline is empty and no more work can be dispatched — matching pre-concurrency semantics where
	// a batch already screened before the abort was noticed still streamed. No unscreened tail is released.
	try {
		consume: for (;;) {
			if (ledger?.stopped) break consume; // finalization is a terminal boundary (coop-review-plane Step 3c)
			if (phaseDeadlineHit) break consume; // the phase itself ran out of its own budget — stop here
			// Flush queued non-content events promptly (watchdog re-arm) before/while we screen.
			while (passthrough.length) {
				const ev = passthrough.shift();
				if (ev) yield ev;
			}

			fireNext();
			if (pipeline.length === 0) {
				if (sourceDone || contentDone) break; // content finished AND no full batch remains (CUR-1907)
				if (signal?.aborted) break; // aborted with only a partial left → drop it (no unscreened tail)
				// Sleep until new tokens/events, the phase deadline, or an abort. The abort matters before the
				// first token (CUR-2243): no window is open then, and a source that ignores the abort would
				// otherwise hold this wait forever.
				await Promise.race([wakeP, phaseDeadline, aborted$]);
				continue;
			}

			const head = pipeline.shift()!;
			// Race the verdict against the same wake signal the empty-pipeline branch above already uses
			// (bump(), fired on every producer token/event), instead of a bare await. A bare await here
			// would block passthrough delivery for the whole screen call: any KeepAlive/status event the
			// producer queued while this call was in flight would sit undelivered until the verdict resolved.
			// On a block of the FIRST batch (nothing released yet) that leaves the client with zero bytes for
			// the entire screen call, which can be long enough to trip an
			// edge/CDN idle-connection timeout and surface as a raw client-side error even though this
			// generator, and the route, never actually failed. Also raced against phaseDeadline (CUR-1657):
			// a verdict that never settles on schedule must not hold this loop past the phase's own budget.
			let res: OutputScreenResult | undefined;
			for (;;) {
				const settled = await Promise.race([
					head.promise.then((r) => ({ verdict: true as const, r })),
					wakeP.then(() => ({ verdict: false as const })),
					phaseDeadline.then(() => ({ verdict: "timeout" as const })),
				]);
				if (settled.verdict === "timeout") break; // abandon this verdict — falls through to break consume above
				if (settled.verdict) {
					res = settled.r;
					break;
				}
				while (passthrough.length) {
					const ev = passthrough.shift();
					if (ev) yield ev;
				}
			}
			if (res === undefined) break consume; // phase deadline won the race — nothing more to release
			// Re-check AFTER the await: a verdict that settles while finalization runs is drained into the
			// report (its promise was on the ledger before this await) but must NOT be released or persisted.
			if (ledger?.stopped) break consume;
			if (res.blocked) {
				blocked = true;
				blockedKind = res.kind === "child_safety" ? "child_safety" : "content_policy";
				blockedCategory = res.category;
				blockedUnscreened = res.unscreened === true;
				break consume;
			}
			released += head.text;
			head.released = true; // mark the ledger entry released so the report never re-appends it
			if (ledger) ledger.released = released;
			yield { type: MessageUpdateType.Stream, token: head.text };
			if (!phaseDeadlineHit) armPhaseDeadline("release"); // progress: restart the idle window
			while (passthrough.length) {
				const ev = passthrough.shift();
				if (ev) yield ev;
			}
		}
	} finally {
		clearTimeout(phaseDeadlineTimer);
		// Content finished cleanly but the source has not (a title still to come). Cancelling it
		// here would drop the title, so its cleanup waits for drainAfterContent, after our FinalAnswer —
		// the order textGeneration already produces with screening off. (CUR-1907)
		deferCleanup =
			contentDone && !sourceDone && !blocked && !phaseDeadlineHit && !ledger?.stopped && !signal?.aborted;
		if (!deferCleanup) await cleanupSource();
		// Any non-content events that arrived after we stopped screening still flush (watchdog/honesty).
		while (passthrough.length) {
			const ev = passthrough.shift();
			if (ev) yield ev;
		}
	}

	// re-throw a captured upstream failure now that cleanup (it.return, passthrough flush) has
	// run — surfaces as a real rejection of this generator instead of a silent empty FinalAnswer, so
	// +server.ts's outer catch logs it and the user sees an actual error rather than nothing. (CUR-782)
	if (producerError) throw producerError;

	const aborted = signal?.aborted ?? false;

	// Screen the trailing remainder: any complete sentences accumulated but not yet flushed as a full
	// batch, plus a genuinely incomplete tail with no terminal punctuation. Skip on abort — an aborted
	// turn must not release tokens the user didn't wait for. Skip on a phase-deadline trip too: firing
	// one more Coop call after the phase already ran out of its own budget defeats the point of the bound.
	if (!blocked && !aborted && !ledger?.stopped && !phaseDeadlineHit && (pendingBatch + buffer).trim()) {
		const tail = pendingBatch + buffer;
		const entry = dispatch(tail, released);
		if (entry !== null) {
			const res = await entry.promise;
			// Re-check after the await: the same terminal boundary the batch loop applies (Step 3c).
			if (!ledger?.stopped) {
				if (res.blocked) {
					blocked = true;
					blockedKind = res.kind === "child_safety" ? "child_safety" : "content_policy";
					blockedCategory = res.category;
					blockedUnscreened = res.unscreened === true;
				} else {
					released += tail;
					entry.released = true;
					if (ledger) ledger.released = released;
					yield { type: MessageUpdateType.Stream, token: tail };
					pendingBatch = "";
					buffer = "";
				}
			}
		}
	}

	// One summary line per answer. firstScreenMs ≈ the output-side TTFT tax (first batch can't show
	// until its screen clears); screenPhaseMs is the wall-clock span of the whole screening phase (the
	// number grouping+pipelining should shrink); totalScreenMs/screens show the aggregate per-call cost.
	// request_id/user ride along via the pino mixin. screens===0 = nothing was screened
	// (empty/aborted-early) — itself informative, but NOT a reliable "nothing arrived" signal on its own
	// (screenChunk only increments screens after its screen() call resolves, so a dispatched-but-still-
	// pending screen also reads screens:0 — see anyTokenArrived above, CUR-1727).
	const screenPhaseMs = Math.round(performance.now() - screenPhaseStart);
	logger.info(
		{
			firstScreenMs: Math.round(firstScreenMs),
			totalScreenMs: Math.round(totalScreenMs),
			screenPhaseMs,
			screens: screenCount,
			rechecks: recheckCount,
			recheckCleared,
			recheckMs: Math.round(recheckMs),
			outBlocked: blocked,
			// The rules.json key that blocked. Server log only: the marker carries just the curated label,
			// which several rules share, so this is the one record of which rule cut an answer (CUR-2320).
			rule: blocked ? blockedCategory : undefined,
			releasedLen: released.length,
			aborted,
			phaseTimedOut: phaseDeadlineHit,
			anyTokenArrived,
			preTokenWaitMs,
			windowMs: deadlineMs,
		},
		"[moderation] output screen timing"
	);
	// Surface the decomposition to the handler for durable persistence on message.timings.
	if (opts.timings) {
		opts.timings.firstScreenMs = Math.round(firstScreenMs);
		opts.timings.totalScreenMs = Math.round(totalScreenMs);
		opts.timings.screenPhaseMs = screenPhaseMs;
		if (preTokenWaitMs !== undefined) opts.timings.screenPreTokenWaitMs = preTokenWaitMs;
	}

	if (blocked) {
		dropClips();
		const child = blockedKind === "child_safety";
		// Curated public-safe rule name for the blocking action, if one is reviewed. The raw action code
		// (blockedCategory) is never placed on the marker — only its resolved label, or nothing.
		const ruleLabel = resolveActionLabel(blockedCategory) ?? undefined;
		// Curated per-rule decline copy for this action, if one is set in rules.json; else null → the
		// generic, reviewed output copy stands.
		const ruleMessage = resolveActionMessage(blockedCategory, (await opts.declineLanguage) ?? "en");
		opts.onModeration?.({
			flagged: true,
			label: blockedKind,
			score: 1,
			kind: blockedKind,
			screened: true,
			truncated: released.trim().length > 0,
			...(ruleLabel ? { ruleLabel } : {}),
			...(blockedUnscreened ? { unscreened: true } : {}),
			...(recheckCleared > 0 ? { rechecked: recheckCleared } : {}),
		});
		if (released.trim()) {
			// Mid-stream block: KEEP the cleared prefix (it passed screening), append an honest notice.
			// A per-rule message (rules.json) overrides the generic truncate notice for this action.
			const notice = blockedUnscreened
				? OUTPUT_UNSCREENED_TRUNCATE
				: (ruleMessage ?? (child ? OUTPUT_CHILD_SAFETY_TRUNCATE : OUTPUT_CONTENT_TRUNCATE));
			// `declineNotice` carries the notice out-of-band so it reaches the route's update() chokepoint
			// UNPROCESSED — honesty and arithmetic guards run on the cleared prefix (real model text) but
			// must never touch curated safety copy. `text` stays composed for any direct caller/test; the
			// route rebuilds it from the guard-processed prefix + this notice (CUR-946).
			yield {
				type: MessageUpdateType.FinalAnswer,
				text: `${released.trimEnd()}\n\n${notice}`,
				interrupted: false,
				declineNotice: notice,
			};
		} else {
			// Nothing shown yet → withhold the whole answer. A per-rule message overrides the generic decline.
			const decline = blockedUnscreened
				? OUTPUT_UNSCREENED_DECLINE
				: (ruleMessage ?? (child ? OUTPUT_CHILD_SAFETY_DECLINE : OUTPUT_CONTENT_DECLINE));
			// `declineText` carries the decline out-of-band (same reason as above): the route applies it
			// verbatim, so it bypasses every downstream model-text guard (CUR-946).
			yield {
				type: MessageUpdateType.FinalAnswer,
				text: decline,
				interrupted: false,
				declineText: decline,
			};
		}
		yield* drainAfterContent();
		return;
	}

	// The screening phase ran out of its own budget before finishing — not a moderation
	// verdict, so this must not read like one (no onModeration flag, no safety copy). `screened: false`
	// tells the trace this turn was never fully verified, which is the honest state to persist. (CUR-1657)
	if (phaseDeadlineHit) {
		dropClips();
		opts.onModeration?.({ flagged: false, label: null, score: 0, kind: "content_policy", screened: false });
		if (released.trim()) {
			yield {
				type: MessageUpdateType.FinalAnswer,
				text: `${released.trimEnd()}\n\n${OUTPUT_SCREEN_TIMEOUT_TRUNCATE}`,
				interrupted: false,
				declineNotice: OUTPUT_SCREEN_TIMEOUT_TRUNCATE,
			};
		} else {
			// No token ever arrived from upstream — OUTPUT_SCREEN_TIMEOUT_DECLINE's "I started to answer"
			// would be false here (CUR-1727).
			const decline = anyTokenArrived ? OUTPUT_SCREEN_TIMEOUT_DECLINE : OUTPUT_SCREEN_NO_TOKENS_DECLINE;
			// With no token at all, no model wrote any of this reply, so say so ahead of it (CUR-1872). The
			// receipt otherwise reads "from training" over a notice this server composed. Marked here, where
			// the copy is chosen, rather than recognised later by its text.
			if (!anyTokenArrived) yield { type: MessageUpdateType.FixedReply, kind: "capacity" };
			yield {
				type: MessageUpdateType.FinalAnswer,
				text: decline,
				interrupted: false,
				declineText: decline,
			};
		}
		return;
	}

	// An abort with NOTHING REAL in `released` — an agent turn's own <think>-wrapped "working
	// on it" placeholder, still unclosed because generation never got further — must not compose a
	// FinalAnswer here. Doing so sets state.finalAnswerReceived before the caller's own abort handler
	// (emitInterruptedFinalAnswer, +server.ts) gets a chance to run, which is the one place that knows
	// about completed agentConfirmations and can tell the user what actually finished instead of a bare
	// placeholder. A real, if partial, answer still finalizes below exactly as before. (CUR-1178)
	if (aborted && !stripThink(released).trim()) {
		dropClips();
		yield* drainAfterContent();
		return;
	}

	// Cleared (or aborted before completion). Finalize with the released text so update()'s honesty
	// guards run and the message persists. On abort, `released` holds only screened-clean chunks.
	opts.onModeration?.({
		flagged: false,
		label: null,
		score: 0,
		kind: "content_policy",
		screened: true,
		...(recheckCleared > 0 ? { rechecked: recheckCleared } : {}),
	});
	yield {
		type: MessageUpdateType.FinalAnswer,
		text: released,
		interrupted: finalInterrupted || aborted,
		// Not carried on the blocked branches above: those replace the answer with a moderation notice,
		// and "the model also ran out of tokens" is not a fact the user needs alongside it.
		...(finalTruncated ? { truncated: true } : {}),
	};
	// An abort or a finalizing route released only part of the answer, and the clip reads all of it.
	if (aborted || ledger?.stopped) dropClips();
	else {
		clipVerdict = "release";
		yield* heldClips.splice(0);
	}
	yield* drainAfterContent();
}

import { logger } from "$lib/chat/server/logger";
import type { FailoverCause } from "$lib/chat/types/MessageUpdate";
import type { Endpoint, EndpointParameters, TextGenerationStreamOutputSimplified } from "./types";
import {
	createHedgeThrottle,
	isHardUpstreamFailure,
	isRateLimited,
	isUpstreamTimeout,
	rateLimitDetail,
	type HedgeThrottle,
} from "./retryPolicy";
import { MessageTooLongError } from "./openai/fitHistory";
import { ToolRoundHandoff } from "./openai/calculateTool";
import { noteAnswered, noteFailed } from "$lib/chat/server/modelBusy";

// The throttle lives in retryPolicy.ts so a tool round can hedge too (CUR-4372); its tests import it from here.
export { createHedgeThrottle };

// Same-model redundancy across inference lanes (CSCS primary → HF, etc.). This is NOT a separate
// "fallback mode" with its own flag — it's just how a model with more than one configured endpoint
// is served: try the lanes in order, and move to the next ONLY on a failure that happens before the
// lane has produced any output. The honesty invariant rides along for free: each lane is a normal
// OpenAI endpoint whose response carries the real `x-inference-provider` header, so the per-turn
// ProvenanceBadge names whichever lane actually served — never claims the primary when a backup ran.
//
// Why "before any output" is the only safe failover point: once a lane yields its first chunk, tokens
// are streaming to the user. Switching lanes then would either duplicate text or splice two different
// answers together. So a mid-stream error AFTER the first yield propagates unchanged (it's the
// existing "late failure" the chat page already handles) — we never fail over once committed.
//
// Construction is cheap (each lane just builds an OpenAI client; no network), and the network call
// happens at the endpoint invocation or the first `next()` — both are covered by the pre-output guard.
//
// ─── A hung lane never throws (CUR-1344) ──────────────────────────────────────────────────────────
//
// Everything described so far is triggered by a thrown error. A lane that accepts the connection and
// then produces nothing throws nothing: `await gen.next()` simply does not settle. The only thing
// that eventually notices is the generation watchdog in the conversation route, which sits above this
// ladder and can therefore only abort the whole turn; by the time it fires, switching lanes is no
// longer in scope, so a retry budget alone is never spent. A turn lost this way also poisons every
// later turn's arithmetic anchor (CUR-1342).
//
// Envoy documents this exact default as a footgun — with no `per_try_timeout`, "a request that times
// out will not be retried as the total timeout budget would have been exhausted."
//
// The fix is NOT to time the attempt out and retry it. Both reference implementations deliberately
// keep the original running: Envoy's `hedge_on_per_try_timeout` issues "a retry ... without resetting
// the original request, leaving multiple upstream requests in flight", and gRPC's A6 `hedgingPolicy`
// sends a second RPC once `hedgingDelay` elapses without a successful response, cancelling the losers
// only "when a non-error response is received". Cancel-and-retry throws away a prefill that was about
// to land; hedging keeps it and takes whichever answers first.
//
// Dean & Barroso ("The Tail at Scale") give the sizing rule — defer the hedge until the first request
// has been outstanding past the 95th-percentile expected latency, which "limits the additional load to
// approximately 5%" — and the caveat that makes the technique affordable: "Permitting more aggressive
// use of hedged requests with moderate resource consumption requires faster cancellation of requests."
//
// That caveat is the one thing streaming hands us for free, and it is why hedging an LLM turn does not
// cost two generations. The pre-output window above is already defined as "before the lane has
// produced any output", so we hedge on TIME TO FIRST CHUNK and cancel the loser AT its first chunk.
// The duplicated work is bounded to a single prefill, and because nothing has been yielded to the
// user yet, the "never splice two answers together" invariant is untouched.

export const HEDGE_ON_FIRST_TOKEN_FLAG = "hedge-on-first-token";

/** A tool turn's later rounds hedge under their own key, so turning them off keeps round one's hedge (CUR-4372). */
export const HEDGE_TOOL_ROUNDS_FLAG = "hedge-tool-rounds";

/** Dean & Barroso's sizing rule is "the 95th-percentile expected latency for this class of requests" —
 *  for the span this hedge timer actually wraps (tBeforeGen to first real token, i.e. `genToFirstTokenMs`
 *  in the persisted timings blob — NOT whole-turn `ttftMs`, which also carries the arithmetic pre-pass
 *  that runs in +server.ts before `ctx` is even built, up to 23s of it). Production p95 for that span is
 *  about 5.9s (CUR-1344); 8s clears it with margin for day-to-day serving variance. */
const DEFAULT_HEDGE_DELAY_MS = 8000;

// Per-instance, which is the right granularity — the same scope gRPC gives a channel.
const sharedHedgeThrottle = createHedgeThrottle();

export type FailoverOptions = {
	/** How long to wait for a first chunk before starting a SECOND attempt ALONGSIDE the first. Size
	 *  it at roughly p95 TTFT per Dean & Barroso. Null or omitted disables hedging entirely and leaves
	 *  the sequential retry this file shipped with, byte for byte — that is what the feature flag off
	 *  position selects. */
	hedgeDelayMs?: number | null;
	/** Defaults to the module-wide bucket. Tests pass their own so one case cannot drain another's. */
	throttle?: HedgeThrottle;
	/** Each lane's served-model id, index for index with `lanes` (lane 0 is the conversation's own
	 *  model). Lets a cross-model backup be named, with the model it replaced, before it answers. */
	laneModels?: (string | undefined)[];
	/** CUR-4043. The conversation model's registry id (`page.data.models[].id`), the key its busy mark
	 *  is kept under. A turn ending on a no-lane-left 429 counts toward the mark; a first chunk from
	 *  that model clears it. Omitted, nothing is recorded. */
	busyKey?: string;
	/** CUR-2316. How long a lane that has a lane behind it may go without a first chunk before the turn
	 *  moves on. Hedging cannot do this: its second attempt goes to the same lane, and when that lane is
	 *  stalled both attempts wait together. Null or omitted keeps the old behaviour, where only a thrown
	 *  error moves the turn, which is what the flag's off position selects. */
	failoverAfterMs?: number | null;
	/** CUR-3939. How long the last lane, which is usually the only one, may go without a first chunk
	 *  before the turn ends on an error. A picked model is never answered by another (CUR-3936), so a
	 *  silent last lane has nothing behind it, and without this the visitor waits for the route's 45s
	 *  generation watchdog. Null or omitted leaves that wait, which the flag's off position selects. */
	lastLaneGiveUpMs?: number | null;
};

/** CUR-2316. The output screen ends a turn that has released nothing for 25s (screenStream.ts), so a
 *  backup lane has to start early enough to answer inside that. 12s leaves the backup about 13s for
 *  its own first token and first screen. It sits above the primary's healthy spread: the answer
 *  lane's genToFirstTokenMs p95 is about 5.9s on production (CUR-1344), and the native-roles hedge
 *  adds about 3s on the turns it fires. */
const DEFAULT_FAILOVER_AFTER_MS = 12_000;


export const FAILOVER_ON_SILENT_LANE_FLAG = "failover-on-silent-lane";

/**
 * The hedge delay and failover deadline for one model's turn (CUR-3487). `allowanceMs` is that model's
 * own first-chunk allowance from harnessProfiles.ts, or null for the default timings. A model given one
 * neither hedges nor moves on before it, since a second attempt that starts mid-prefill only repeats
 * the prefill. Each flag's off position still turns its half off.
 */
export function firstChunkTimings(
	allowanceMs: number | null,
	{
		hedging,
		silentLaneFailover,
		giveUpMs = null,
	}: { hedging: boolean; silentLaneFailover: boolean; giveUpMs?: number | null }
): Pick<FailoverOptions, "hedgeDelayMs" | "failoverAfterMs" | "lastLaneGiveUpMs"> {
	return {
		hedgeDelayMs: hedging ? Math.max(DEFAULT_HEDGE_DELAY_MS, allowanceMs ?? 0) : null,
		failoverAfterMs: silentLaneFailover ? (allowanceMs ?? DEFAULT_FAILOVER_AFTER_MS) : null,
		// opt-in per model (harnessProfiles.ts `silentGiveUpMs`), under the same flag. (CUR-3939)
		lastLaneGiveUpMs: silentLaneFailover ? giveUpMs : null,
	};
}

export function withFailover(lanes: Endpoint[], opts: FailoverOptions = {}): Endpoint {
	if (lanes.length === 0) {
		throw new Error("withFailover requires at least one endpoint lane");
	}
	// A single lane has nothing to fail over to, so failoverAfterMs never applies to it; it can still give up.
	if (
		lanes.length === 1 &&
		(opts.hedgeDelayMs ?? null) === null &&
		(opts.lastLaneGiveUpMs ?? null) === null
	) {
		// Single lane, hedging off: byte-identical to having no wrapper at all, so deployments with one
		// endpoint (and anything without a backup configured) are completely unaffected. With hedging ON
		// the wrapper stays, deliberately — a second attempt at the only lane there is, is precisely the
		// case this change exists for, and skipping the wrapper would leave it unprotected.
		return lanes[0];
	}

	return async function failoverEndpoint(params: EndpointParameters) {
		return failoverStream(lanes, params, opts);
	};
}

// A lane can be a DIFFERENT model than the one before it (a backup configured via FALLBACK_MODEL_ID),
// so falling over on the first transient error means a routine timeout on the primary silently swaps
// the model family for the whole turn, with none of the primary's safety/arithmetic/grounding tuning
// validated against whatever answered (CUR-1210). Retrying the SAME lane a couple of times first (the
// same shape as the agent-service and litellm-backend retries) gives a transient failure a real
// chance to clear before the model identity changes. A lane that is actually down still fails over
// once the retry budget is spent.
//
// The second same-lane attempt starts on a timer as well as on an error, concurrently rather than
// afterwards (a hedge, CUR-1344). The count is the same count, so a hedge cannot reach the backup
// model any sooner than a retry could.
const SAME_LANE_RETRY_ATTEMPTS = 2;
const jitteredRetryDelayMs = () => 100 + Math.random() * 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type LaneAttempt =
	| {
			ok: true;
			gen: AsyncGenerator<TextGenerationStreamOutputSimplified, void, void>;
			// Narrower than IteratorResult on purpose: `ok: true` now GUARANTEES a chunk arrived, so the
			// empty-completion case below cannot be reached by a caller that forgot to check for it.
			first: IteratorYieldResult<TextGenerationStreamOutputSimplified>;
	  }
	| { ok: false; error: unknown };

/** CUR-1344. A generator that comes back immediately done produced a zero-token answer, which is the
 *  lost-turn symptom this whole change exists for — not the "clean empty completion" this file used to
 *  call it. It is the same failure as a hang, arriving faster, and it feeds the same retry path. */
const EMPTY_COMPLETION = new Error(
	"lane completed with no chunks — a zero-token answer is a lost turn, not a clean finish"
);

/** The failover deadline ran out before the lane's first chunk (CUR-2316). Its own class so the record
 *  can tell a silent lane from one that refused. On the last lane it ends the turn (CUR-3939), and its
 *  504 is the status the visitor's timeout notice carries. */
export class NoFirstChunkError extends Error {
	readonly status = 504;
}

/**
 * A failure that says the model answered nobody, so it counts toward the model's busy mark (modelBusy.ts):
 * a 429, a gateway timeout, a 404 or other 5xx (CUR-4629), or a lane that sent nothing before its give-up.
 * A 400 or a dropped connection says nothing settled about the model and is left out.
 */
function countsTowardBusy(err: unknown): boolean {
	return isRateLimited(err) || isUpstreamTimeout(err) || isHardUpstreamFailure(err) || err instanceof NoFirstChunkError;
}

/** Any spec fault set on this turn. A faulted failure is the spec's, and the busy mark is everyone's. */
function faultedParams(params: EndpointParameters): boolean {
	return Boolean(
		params.failPrimaryLane ||
			params.hangPrimaryLane ||
			params.hangEveryLane ||
			params.rateLimitPrimaryLane ||
			params.rateLimitEveryLane ||
			params.rateLimitToolRound ||
			params.rateLimitToolRoundSustained ||
			params.substituteServedModel
	);
}

/** Why the lane before a backup gave up, in the words the persisted record keeps (CUR-3313). An event instance's
 *  logs are not retained, so without this a backup answer says only that the primary was "unavailable". */
function failoverCause(error: unknown): FailoverCause {
	if (error === EMPTY_COMPLETION) return "empty-completion";
	if (error instanceof NoFirstChunkError) return "no-first-chunk";
	if (isRateLimited(error)) return "rate-limited";
	const status = (error as { status?: unknown } | null)?.status;
	if (typeof status === "number" && Number.isInteger(status)) return `http-${status}`;
	return "error";
}

/** Drop an attempt we are not going to use. `gen.return()` runs the generator's own finally blocks,
 *  which is what actually closes the underlying HTTP response — the "faster cancellation" the hedging
 *  literature names as the thing that keeps the duplicated work down to one prefill. */
function abandon(gen: AsyncGenerator<TextGenerationStreamOutputSimplified, void, void>): void {
	void Promise.resolve(gen.return(undefined)).catch(() => {});
}

/** One attempt, carried exactly to the end of the pre-output window — the invocation plus the first
 *  pull, the same safety boundary the file's header describes. Never throws: a rejection becomes
 *  `{ok:false}` so that several of these can be raced against each other and against a timer. */
async function openLane(
	lane: Endpoint,
	params: EndpointParameters,
	signal?: AbortSignal
): Promise<LaneAttempt> {
	try {
		const gen = await lane(signal ? { ...params, abortSignal: signal } : params);
		const first = await gen.next();
		if (first.done) {
			abandon(gen);
			return { ok: false, error: EMPTY_COMPLETION };
		}
		return { ok: true, gen, first };
	} catch (error) {
		return { ok: false, error };
	}
}

/** CUR-2460. The request a lane serving `laneModel` should receive: `params` with each of that model's
 *  rewrite pairs applied to the system preprompt and to every string message. Returns `params` itself
 *  when there is nothing to change, so the primary lane's request stays the same object. */
function paramsForLane(params: EndpointParameters, laneModel: string | undefined): EndpointParameters {
	const pairs = laneModel ? params.laneRewrites?.[laneModel] : undefined;
	if (!pairs?.length) return params;
	const apply = (text: string) => pairs.reduce((t, [from, to]) => (from ? t.split(from).join(to) : t), text);
	return {
		...params,
		preprompt: typeof params.preprompt === "string" ? apply(params.preprompt) : params.preprompt,
		messages: params.messages.map((m) =>
			typeof m.content === "string" ? { ...m, content: apply(m.content) } : m
		),
	};
}

/** CUR-2307. A handed-over tool transcript with the lane's rewrite pairs applied to every string
 *  message, the same renaming paramsForLane gives a fresh request. Tool results are strings too; a pair
 *  names the model, which a search result quoting it would also carry, and that is the same trade the
 *  fresh request already makes. */
function transcriptForLane(
	params: EndpointParameters,
	laneModel: string | undefined,
	messages: ToolRoundHandoff["messages"]
): ToolRoundHandoff["messages"] {
	const pairs = laneModel ? params.laneRewrites?.[laneModel] : undefined;
	if (!pairs?.length) return messages;
	const apply = (text: string) => pairs.reduce((t, [from, to]) => (from ? t.split(from).join(to) : t), text);
	return messages.map((m) =>
		typeof m.content === "string" ? ({ ...m, content: apply(m.content) } as typeof m) : m
	);
}

const HEDGE_TICK = Symbol("hedge");

/** A cancellable timer. The cancel matters: an uncleared `setTimeout` keeps Node's event loop alive,
 *  and this races one per iteration. */
function hedgeTimer(ms: number): { promise: Promise<typeof HEDGE_TICK>; cancel: () => void } {
	let handle: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<typeof HEDGE_TICK>((resolve) => {
		handle = setTimeout(() => resolve(HEDGE_TICK), ms);
	});
	return { promise, cancel: () => clearTimeout(handle) };
}

/** CUR-2346. Whether a failed attempt should be followed by another at the SAME lane. A rate-limited
 *  lane is refused for the rest of its window: a second request 100–300ms later lands inside the same
 *  minute, fails the same way, and spends another unit of the cap every other visitor shares (Mistral's
 *  key allows 30 a minute, CUR-2307). With a next lane behind it the turn moves there instead. The last
 *  lane keeps its retry, because there is nowhere else to go. A too-long refusal (CUR-2893) is never
 *  retried on any lane: it is computed before the call, so a second attempt computes it again. */
function worthRetrying(error: unknown, hasNextLane: boolean): boolean {
	if (error instanceof MessageTooLongError) return false;
	return !(hasNextLane && isRateLimited(error));
}

/** Pre-CUR-1344 behaviour, unchanged, and what the flag's off position selects: attempts in sequence,
 *  each one started only after the previous one has failed. */
async function attemptLaneSequential(
	lane: Endpoint,
	params: EndpointParameters,
	hasNextLane: boolean
): Promise<LaneAttempt> {
	let error: unknown;
	for (let attempt = 1; attempt <= SAME_LANE_RETRY_ATTEMPTS; attempt++) {
		const opened = await openLane(lane, params);
		if (opened.ok) return opened;
		error = opened.error;
		if (!worthRetrying(error, hasNextLane)) break;
		if (attempt < SAME_LANE_RETRY_ATTEMPTS) await sleep(jitteredRetryDelayMs());
	}
	return { ok: false, error };
}

/** Invokes one lane up to SAME_LANE_RETRY_ATTEMPTS times, only through the pre-output window —
 *  identical safety boundary to the caller's own "before any output" invariant, just applied
 *  per-attempt instead of per-lane. With `hedgeDelayMs` set, the attempts may overlap. */
async function attemptLane(
	lane: Endpoint,
	params: EndpointParameters,
	opts: FailoverOptions,
	hasNextLane: boolean
): Promise<LaneAttempt> {
	const hedgeDelayMs = opts.hedgeDelayMs ?? null;
	if (hedgeDelayMs === null) return attemptLaneSequential(lane, params, hasNextLane);
	const throttle = opts.throttle ?? sharedHedgeThrottle;

	const live = new Map<number, Promise<{ id: number; attempt: LaneAttempt }>>();
	// One AbortController PER ATTEMPT, so a loser can be cut without cutting the winner — every lane
	// shares the one `params` object, and therefore the one turn-level abortSignal, which cannot
	// distinguish them. CUR-1658.
	const controllers = new Map<number, AbortController>();
	let started = 0;
	let lastError: unknown;

	const start = () => {
		const id = started++;
		const controller = new AbortController();
		// Chain the turn's own signal in, so aborting the turn still cuts every attempt. The
		// already-aborted case needs its own branch: addEventListener only fires on a FUTURE transition,
		// so a listener attached after the signal has already aborted never runs — and this start() is
		// reached mid-race, after a hedge delay, which is exactly when a caller cancellation is likely to
		// have already landed. Getting that wrong would reproduce this ticket's own bug one level over:
		// an attempt launched with a controller nothing will ever abort. A listener rather than
		// AbortSignal.any() only so there is no minimum Node version to reason about.
		// The turn's abort REASON is forwarded too: the agent endpoint reads it to tell the route's
		// watchdog (GenerationWatchdogAbort) from a person's Stop, and a bare abort() here would erase it,
		// and every watchdog-ended agent turn would read as "stopped".
		const turnSignal = params.abortSignal;
		if (turnSignal?.aborted) {
			controller.abort(turnSignal.reason);
		} else {
			turnSignal?.addEventListener("abort", () => controller.abort(turnSignal.reason), { once: true });
		}
		controllers.set(id, controller);
		live.set(
			id,
			openLane(lane, params, controller.signal).then((attempt) => ({ id, attempt }))
		);
	};
	/** Cut every attempt except `keepId` — synchronously, which is the whole point (see the winner
	 *  branch below for why the previous promise-attached cancellation could never run). */
	const cutAllBut = (keepId: number | null) => {
		for (const [id, controller] of controllers) {
			if (id === keepId) continue;
			controller.abort();
		}
		controllers.clear();
	};
	start();

	while (live.size > 0) {
		const mayHedge = started < SAME_LANE_RETRY_ATTEMPTS && throttle.allows();
		const timer = mayHedge ? hedgeTimer(hedgeDelayMs) : null;
		let raced: { id: number; attempt: LaneAttempt } | typeof HEDGE_TICK;
		try {
			raced = await Promise.race<{ id: number; attempt: LaneAttempt } | typeof HEDGE_TICK>([
				...live.values(),
				...(timer ? [timer.promise] : []),
			]);
		} finally {
			timer?.cancel();
		}

		if (raced === HEDGE_TICK) {
			logger.info(
				// Which call hedged: a side call (a title, a planner) goes through this same wrapper (CUR-4372).
				{ hedgeDelayMs, inFlight: live.size, model: opts.busyKey, answer: params.servesUserAnswer === true },
				"[failover] no first chunk within the hedge delay — starting a second attempt alongside the first, not instead of it"
			);
			start();
			continue;
		}

		live.delete(raced.id);
		const { attempt } = raced;

		if (attempt.ok) {
			throttle.record(true);
			// Cut the losers' REQUESTS first, and do it now rather than when their promises settle.
			//
			// The promise-attached cancellation below cannot reach the case that actually hurts: a lane
			// whose first pull never settles leaves openLane's promise pending forever, so `.then()` never
			// runs and abandon() is never called at all. That request then stays open, the turn's upstream
			// async iterator never returns `done`, and screenStream's consumer parks on it until the 45s
			// watchdog — the user sees nothing and the turn is recorded as a timeout (CUR-1657). `gen.return()` is no substitute either — it queues behind the
			// in-flight next() and cannot interrupt a pull that never settles.
			cutAllBut(raced.id);
			// Still abandon any loser that DOES return a generator: return() runs its finally blocks,
			// which is the graceful close, where the abort above is the one that always lands.
			for (const pending of live.values()) {
				void pending.then(({ attempt: loser }) => {
					if (loser.ok) abandon(loser.gen);
				}, noop);
			}
			live.clear();
			return attempt;
		}

		throttle.record(false);
		lastError = attempt.error;
		// Only refill when nothing else is in flight — otherwise a fast failure on attempt 1 would
		// spend the budget while attempt 2, started by the hedge, is still perfectly alive.
		if (
			live.size === 0 &&
			started < SAME_LANE_RETRY_ATTEMPTS &&
			worthRetrying(attempt.error, hasNextLane)
		) {
			await sleep(jitteredRetryDelayMs());
			start();
		}
	}

	// Out of attempts: nothing here is going to be used, so cut whatever is still open.
	cutAllBut(null);
	return { ok: false, error: lastError };
}

function noop() {}

/** attemptLane with a first-chunk deadline (CUR-2316). The lane runs on its own controller, chained to
 *  the turn's, so running out of time cuts every attempt at this lane without cutting the turn. An
 *  attempt that does produce a chunk after the deadline is closed, never read. */
async function attemptLaneWithin(
	lane: Endpoint,
	params: EndpointParameters,
	opts: FailoverOptions,
	ms: number,
	hasNextLane: boolean
): Promise<LaneAttempt> {
	const controller = new AbortController();
	// Forwards the turn's abort reason, for the same reason as start() in the hedged race above.
	const onTurnAbort = () => controller.abort(params.abortSignal?.reason);
	if (params.abortSignal?.aborted) controller.abort(params.abortSignal.reason);
	else params.abortSignal?.addEventListener("abort", onTurnAbort, { once: true });

	const pending = attemptLane(
		lane,
		{ ...params, abortSignal: controller.signal },
		opts,
		hasNextLane
	);
	const timer = hedgeTimer(ms);
	let raced: LaneAttempt | typeof HEDGE_TICK;
	try {
		raced = await Promise.race([pending, timer.promise]);
	} finally {
		timer.cancel();
	}
	if (raced !== HEDGE_TICK) return raced;

	params.abortSignal?.removeEventListener("abort", onTurnAbort);
	controller.abort();
	void pending.then((late) => {
		if (late.ok) abandon(late.gen);
	}, noop);
	logger.warn(
		{ failoverAfterMs: ms, lastLane: !hasNextLane },
		hasNextLane
			? "[failover] no first chunk within the failover deadline — moving the turn to the next lane"
			: "[failover] no first chunk from the last lane within its give-up — ending the turn on an error"
	);
	return {
		ok: false,
		error: new NoFirstChunkError(`lane produced no first chunk within ${ms}ms`),
	};
}

/** The `primary_lane_hangs` fault's stand-in for the primary: the call is accepted and nothing comes
 *  back, not even headers, until something aborts it. The OpenAI SDK's own timeout on this path is
 *  PLATFORM_MAX_DURATION_MS (endpointOai.ts), so in a real stall this is what the ladder sees for the
 *  whole visit. */
const headerlessLane: Endpoint = (p) =>
	new Promise((_, reject) => {
		const fail = () => reject(new Error("primary_lane_hangs fault: the lane sent no headers"));
		if (p.abortSignal?.aborted) return fail();
		p.abortSignal?.addEventListener("abort", fail, { once: true });
	});

/** The `primary_lane_rate_limited` fault's stand-in for the primary (CUR-2346): the OpenAI SDK's
 *  RateLimitError as a Mistral 429 reaches this file, status and text (CUR-2307 Observed). Unlike
 *  `lane_rate_limited`, which throws before any endpoint is called, this one goes through the lane
 *  loop, so it exercises what a real over-cap turn does here. */
const rateLimitedLane: Endpoint = async () => {
	throw Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
};

async function* failoverStream(
	lanes: Endpoint[],
	params: EndpointParameters,
	opts: FailoverOptions
) {
	let lastError: unknown;
	let skippedPrimary = false;
	let handoff: ToolRoundHandoff | undefined;
	for (let i = 0; i < lanes.length; i++) {
		const isLast = i === lanes.length - 1;
		if (i === 0 && params.failPrimaryLane && !isLast) {
			logger.warn({ fault: "primary_lane_down" }, "[failover] fault injection: skipping the primary lane");
			skippedPrimary = true;
			continue;
		}
		// CUR-2239. A backup lane serving a different model is announced before its attempt starts: the
		// switch itself (`failover`, so the live log and the receipt can show both models) and the backup's
		// id (`routerMetadata`, so the live line stops crediting the primary through the backup's prefill).
		// The lane's own first chunk seeds the same id, so the second half only moves the fact earlier.
		const laneModel = opts.laneModels?.[i];
		const primaryModel = opts.laneModels?.[0];
		if (i > 0 && laneModel && primaryModel && laneModel !== primaryModel) {
			yield {
				token: { id: -1, text: "", logprob: 0, special: true },
				generated_text: null,
				details: null,
				failover: {
					from: primaryModel,
					to: laneModel,
					reason: i === 1 && skippedPrimary ? "skipped" : "unavailable",
					...(lastError === undefined ? {} : { cause: failoverCause(lastError) }),
				},
				routerMetadata: { model: laneModel },
			} as TextGenerationStreamOutputSimplified;
		}
		const lane =
			i === 0 && params.rateLimitPrimaryLane
				? rateLimitedLane
				: (i === 0 && params.hangPrimaryLane) || params.hangEveryLane
					? headerlessLane
					: lanes[i];
		const deadline = isLast ? (opts.lastLaneGiveUpMs ?? null) : (opts.failoverAfterMs ?? null);
		// A backup serving another model is told it is that model (CUR-2460).
		const forLane = i > 0 && laneModel !== primaryModel ? paramsForLane(params, laneModel) : params;
		// `wrong_model_served` and the sustained tool-round fault refuse the first lane only, so a backup
		// lane answers clean. A backup taking over a tool loop gets its transcript, renamed the same way.
		const laneParams =
			i > 0
				? {
						...forLane,
						substituteServedModel: undefined,
						rateLimitToolRoundSustained: undefined,
						...(handoff
							? {
									toolTranscript: {
										messages: transcriptForLane(params, laneModel !== primaryModel ? laneModel : undefined, handoff.messages),
										round: handoff.round,
									},
								}
							: {}),
					}
				: forLane;
		const attempt =
			deadline === null
				? await attemptLane(lane, laneParams, opts, !isLast)
				: await attemptLaneWithin(lane, laneParams, opts, deadline, !isLast);
		if (!attempt.ok) {
			lastError = attempt.error;
			// CUR-2893. A message too long for the chosen model is refused, not served by a lane with a
			// longer context: that lane is usually another model, which would answer in place of the one
			// the visitor picked. The refusal is decided before any call, so a retry would only repeat it.
			if (attempt.error instanceof MessageTooLongError) throw attempt.error;
			// The turn itself was ended (the route's watchdog, or the visitor's Stop) while this lane was
			// still silent. Nobody is waiting for an answer, so no backup is called or announced.
			if (params.abortSignal?.aborted) throw attempt.error;
			if (isRateLimited(attempt.error)) {
				logger.warn(
					{ lane: i, model: laneModel ?? primaryModel, ...rateLimitDetail(attempt.error) },
					isLast
						? "[failover] last lane answered 429 — no lane left, the error goes to the turn's handler"
						: "[failover] lane answered 429 — moving to the next lane without a same-lane retry"
				);
			}
			if (isLast) {
				// A lane that stays silent past its deadline answers nobody either, so it counts
				// toward the busy mark the same as a 429.
				// A spec's injected stall or 429 is not the model's, and the mark is shared by everyone on the
				// deployment, so a faulted lane never counts. CUR-4345: a gateway 504 is the host giving up on
				// the model, so it counts too, and CUR-4629 a 404 or any other 5xx (countsTowardBusy). (CUR-4098)
				const faulted =
					params.hangEveryLane ||
					params.rateLimitEveryLane ||
					(i === 0 && (params.hangPrimaryLane || params.rateLimitPrimaryLane));
				if (opts.busyKey && !faulted && countsTowardBusy(attempt.error)) void noteFailed(opts.busyKey);
				throw attempt.error; // all lanes exhausted — surface the last error to the normal handler
			}
			continue; // this lane's retry budget is spent — try the next lane
		}

		// This lane produced a real first chunk — commit to it. An empty completion never reaches here;
		// openLane turns it into EMPTY_COMPLETION and it takes the failure path above.
		const { gen, first } = attempt;
		if (opts.busyKey && (!laneModel || laneModel === primaryModel)) void noteAnswered(opts.busyKey);
		// From here errors PROPAGATE: we've shown the user this lane's output and must not splice in
		// another lane's answer. This is the existing mid-stream / late-failure path. The one exception is
		// a tool loop whose later round stayed rate-limited before any answer text (CUR-2307): the reader
		// has seen only tool frames, so the next lane continues the same transcript and no tool reruns.
		let shownText = false;
		try {
			let next: IteratorResult<TextGenerationStreamOutputSimplified, void> = first;
			while (!next.done) {
				if (!next.value.token?.special && (next.value.token?.text ?? "").trim() !== "") shownText = true;
				yield next.value;
				next = await gen.next();
			}
		} catch (error) {
			// A later tool round that fails hard before any answer text (the router's 404 on
			// round 2, after round 1 answered) leaves the visitor with nothing, so it counts toward the busy
			// mark as a failure before the first chunk does. The first chunk's noteAnswered already ran, so
			// one such turn is one failure, never a mark on its own.
			// A handoff to the next lane is not an end: that lane continues the transcript. (CUR-4629)
			const handedOn = error instanceof ToolRoundHandoff && !isLast;
			const ended = error instanceof ToolRoundHandoff ? error.cause : error;
			if (
				!shownText &&
				!handedOn &&
				opts.busyKey &&
				(!laneModel || laneModel === primaryModel) &&
				!faultedParams(params) &&
				countsTowardBusy(ended)
			)
				void noteFailed(opts.busyKey);
			if (!(error instanceof ToolRoundHandoff)) throw error;
			if (isLast || shownText) throw error.cause;
			handoff = error;
			lastError = error.cause;
			logger.warn(
				{ lane: i, model: laneModel ?? primaryModel, round: error.round, ...rateLimitDetail(error.cause) },
				"[failover] tool round still 429 before any answer text — the next lane continues the transcript"
			);
			continue;
		}
		return;
	}
	// Unreachable (the loop returns or throws), but satisfies the type checker.
	throw lastError;
}

/**
 * Each lane's model id for the failover record, index for index with `endpoints`. A host that names the
 * model differently (CUR-2928) is asked for its own id but answers under ours (`servedAs`), so the record
 * names ours too: `mistral-large-2512`, never the router's `mistralai/mistral-large-2512`.
 */
export function laneModelIds(
	id: string,
	endpoints: readonly object[]
): string[] {
	return endpoints.map((e) => {
		const { modelId, servedAs } = e as { modelId?: string; servedAs?: string };
		return servedAs || modelId || id;
	});
}

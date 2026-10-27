/**
 * The generation deadline ladder — every wall-clock bound a single chat turn is measured against,
 * in one place, ordered.
 *
 * The rungs are consumed by the conversation route, generationState, backgroundGenerations and the
 * updates-route sidecar. They are not independent: a turn passes through all of them in sequence,
 * and raising one without the others reintroduces a failure the others exist to prevent. Agent
 * turns run far longer than ordinary ones, so the generation rung is split by turn kind; see
 * DEFAULT_AGENT_GENERATION_TIMEOUT_MS.
 *
 * Read top to bottom; each rung is expressed as the rung below it plus a NAMED margin, so the
 * ordering is structural rather than a coincidence of five magic numbers.
 *
 *   prestream chain (60s)
 *     → generation watchdog (env, clamped ≤155s) — silence timer (45s, primary) inside the same cap (backstop)
 *       → hard unwind grace (+15s)
 *         → emergency cleanup tail (+3×5s)
 *           → platform kill (300s)
 *
 * and, on the client side:
 *
 *   generation staleness (180s) → background-track eviction (240s)
 *
 * TWO SEPARATE INVARIANTS live here, and they do not have the same terms:
 *
 *   1. INVOCATION LIFETIME — chain + gen + grace + tail < PLATFORM. Everything the serverless
 *      invocation can spend before the platform kills it mid-flight (which runs no catch/finally,
 *      persists no terminal update, and hangs the client's spinner forever).
 *   2. CLAMP — gen + grace + (the part of the cleanup tail that precedes the `updatedAt` write)
 *      < STALE. This one EXCLUDES the rest of the tail; see MAX_SAFE_GENERATION_TIMEOUT_MS.
 *
 * What the ladder deliberately does NOT budget: the prestream residual (see
 * MAX_SAFE_GENERATION_TIMEOUT_MS) and, in the clamp, the post-`updatedAt` cleanup steps. Neither
 * invariant here is a total-turn budget — don't read it as one.
 */

/**
 * The serverless platform kill. There is deliberately no per-route `export const config` anywhere:
 * one changes the adapter's function layout and can drop routes from the catchall manifest
 * (scripts/verify-route-configs.mjs guards it). `vercel.json` has no `functions` block and
 * `svelte.config.js` sets no global `maxDuration`, so every route inherits the Vercel project
 * default of 300s, the mark at which a hung route is killed.
 *
 * Single source of truth on purpose: restating this number elsewhere lets the copies drift.
 * routes/chat/api/v2/conversations/updates/lifetime.ts re-exports it for the SSE lifetime spec.
 */
export const PLATFORM_MAX_DURATION_MS = 300_000;

/**
 * Hard backstop for the pre-stream chain (conversation load, rate limits, model resolve, agent
 * route, turn append, W2 claim, persist). Generous enough for a cold start — resolveAgentRoute
 * alone can wait ~20s — while still proving that a chain past this mark is stuck, not slow.
 * Consumed at conversation/[id]/+server.ts.
 */
export const PRESTREAM_CHAIN_DEADLINE_MS = 60_000;

/**
 * Budget for each best-effort emergency-cleanup await (a terminal Status emit, a persist, a
 * finishGeneration) on a shed or hard-deadline path. Bounds any single DB/stream call so cleanup
 * cannot itself wedge the invocation to the platform kill.
 */
export const EMERGENCY_CLEANUP_BUDGET_MS = 5_000;

/** The cleanup tail runs at most three bounded steps on the hard-deadline path. */
export const EMERGENCY_TAIL_MS = 3 * EMERGENCY_CLEANUP_BUDGET_MS;

/**
 * How long the route gives an aborted generation to unwind on its own before taking control back
 * unconditionally (raceGenerationDeadline fires at `genTimeoutMs + HARD_UNWIND_GRACE_MS`).
 */
export const HARD_UNWIND_GRACE_MS = 15_000;

/**
 * How long a generation may go without any database write before the UI declares it dead.
 * `conversation.updatedAt` is bumped when a generation starts (the pre-stream message write) and
 * when it ends (persistConversation), so a non-terminal conversation quiet longer than this belongs
 * to a pod that crashed before persisting — it will never become terminal on its own.
 *
 * Raised 120s → 180s for agent turns. MUST stay under MAX_TRACK_DURATION_MS (see below).
 */
export const GENERATION_STALE_MS = 180_000;

/**
 * Margin between staleness and the client poller's eviction of a background generation. Staleness
 * has to fire FIRST: the poller drops the entry at MAX_TRACK_DURATION_MS, so if "this generation is
 * dead" hasn't been signalled by then it never reaches the UI and the spinner hangs forever (the
 * cold-lane 503 → infinite-spinner failure).
 */
export const TRACK_EVICTION_MARGIN_MS = 60_000;

/**
 * Maximum time an unpersisted client turn is tracked before we give up and let the normal server
 * reconcile resume. Shared by BackgroundGenerationPoller (evict) and conversation/[id]/+page.svelte
 * (release the cache/early-failure veto) so they expire on the same clock.
 */
export const MAX_TRACK_DURATION_MS = GENERATION_STALE_MS + TRACK_EVICTION_MARGIN_MS;

/**
 * Watchdog default for an ORDINARY turn, when GENERATION_TIMEOUT_MS is unset or unparseable.
 *
 * Sized against production `[turn] outcome` logs over 14 days: genElapsedMs p50 3.9s / p90 10.2s /
 * p99 20.1s / max 22.2s. 45s is ~2× the observed worst case, which is the headroom a stall detector
 * wants: long enough that a slow turn is never mistaken for a dead one, short enough that a
 * genuinely hung lane surfaces a retryable error quickly.
 */
export const DEFAULT_GENERATION_TIMEOUT_MS = 45_000;

/**
 * How long a generation may go with NO new content token before the watchdog treats it as stalled —
 * the PRIMARY trigger (CUR-58). `genTimeoutMs` above stays as the backstop: a lane emitting a token
 * every 20s must still die at the total cap eventually, or it rides silently to the platform kill
 * (PLATFORM_MAX_DURATION_MS) with no terminal write. Silence-awareness narrows WHEN the existing
 * abort fires; it does not replace the ceiling that decides whether it ever does.
 *
 * Same 45s as DEFAULT_GENERATION_TIMEOUT_MS, and deliberately not split by turn kind the way the
 * total cap is: "no token for 45s" is exactly as suspicious on an agent turn as an ordinary one — the
 * two turn kinds differ in how long the WHOLE job can legitimately run (13-26 sequential model calls
 * vs one), not in how long a single stretch of silence is tolerable. For an ordinary turn (total cap
 * also 45s) this is a no-op: the two thresholds coincide, matching CUR-58's own evidence that every
 * real firing there was already silence from the first token, never a slow-but-streaming turn caught
 * mid-flight. The actual gain is on agent turns, where the total backstop is up to 155s
 * (MAX_SAFE_GENERATION_TIMEOUT_MS): a genuinely stuck agent turn is now caught at 45s of true silence
 * instead of riding the full ceiling, while one making steady progress — a token or tool call at
 * least every 45s — is never touched before it finishes on its own.
 */
export const DEFAULT_SILENCE_TIMEOUT_MS = 45_000;

/** How often the silence watchdog polls for staleness. Cheap (one Date.now() comparison against an
 *  already-tracked timestamp) and frequent enough that a real stall surfaces within one interval of
 *  crossing the threshold, not a whole extra timeout cycle later. */
export const SILENCE_CHECK_INTERVAL_MS = 5_000;

/**
 * Ceiling the env-supplied generation timeout is clamped to.
 *
 *   MAX_SAFE = GENERATION_STALE_MS − HARD_UNWIND_GRACE_MS − 2 × EMERGENCY_CLEANUP_BUDGET_MS
 *
 * The coefficient on the cleanup budget is 2 — not 3, not 0. GENERATION_STALE_MS is measured
 * against `conversation.updatedAt`, not against the SSE event. On the hard-deadline path that write
 * lands in the SECOND bounded step (the `Promise.race([persistConversation, budget])` in the route's
 * deadline catch), behind the terminal Status `boundedSettle` that precedes it. The third step,
 * `finishGeneration`, runs after the staleness clock has already been reset by that write and must
 * be excluded — budgeting it would shrink the usable window for nothing.
 *
 * A naive `STALE − GRACE` (165s) is wrong in the other direction: an operator setting the env to
 * that ceiling produces 165 + 15 + 5 = 185s against a 180s stale window, i.e. a live turn declared
 * dead. 155s is the largest value that cannot do that.
 *
 * The prestream chain is NOT a term here. `gen + grace < stale` is sound because the `updatedAt`
 * write is effectively the last act of the prestream chain — everything expensive precedes it and
 * every await between it and the watchdog arm is inside an unawaited closure, so the residual is
 * structurally ~0. Nothing in the type system enforces that; it's guarded by comments at both sites
 * in conversation/[id]/+server.ts. Do not "fix" it by adding a PRESTREAM_CHAIN_DEADLINE_MS term —
 * that would budget a ~0 quantity, cap generation at 105s, and gut the change.
 */
export const MAX_SAFE_GENERATION_TIMEOUT_MS =
	GENERATION_STALE_MS - HARD_UNWIND_GRACE_MS - 2 * EMERGENCY_CLEANUP_BUDGET_MS;

/**
 * The longest the input safety screen may run (guardGate.ts's operation-deadline cap, CUR-3749).
 *
 * The route starts the generation watchdog's clock when the screen ends rather than when the
 * stream opens, so a long paste's screen no longer eats the 45s an ordinary turn has to answer. The
 * time it may add is `screenAllowanceMs(genTimeoutMs)`, and that keeps screen + generation inside
 * MAX_SAFE_GENERATION_TIMEOUT_MS, so both invariants above hold with no new term: an agent or local
 * turn, whose watchdog is already MAX_SAFE, gets no extra time and screens inside its own budget as
 * before.
 *
 * 100s fits a 100k paste (126 judge calls, 32 rounds of 4 at 3s) with room for the media pass that
 * runs before it, under the 110s an ordinary turn's 45s leaves.
 */
export const MAX_INPUT_SCREEN_MS = 100_000;

/**
 * Watchdog default for an AGENT turn (`AGENT_GENERATION_TIMEOUT_MS` overrides it).
 *
 * An agent turn and an ordinary turn have nothing in common on this axis. Ordinary turns top out
 * around 22s; an agent turn is 13–26 SEQUENTIAL model calls, so the 45s ordinary default would kill 7 in
 * 11 successful agent trials after the work is finished and its side-effects verified, and the user
 * would see a failure on a task the agent completed (CUR-144). That is why this is its own number.
 *
 * Production agent runs over 30 days (Axiom `agent-service`, `run.finished`, 122 runs):
 *
 *   COMPLETED  n=108   p50 10.9s   p90 48.0s   p99 87.0s   max 106.6s
 *   FAILED     n=13    p50 25.0s   p90 37.3s               max 156.5s
 *
 * MAX_SAFE clears the worst completed run by 45%. 130 of 133 attempts stopped `end_turn` (the model
 * finishing on its own) and none stopped on a wall clock under a 300s ceiling. The one run past 150s
 * (156.5s) also stopped `end_turn` and then failed verification, so it was not a deadline casualty.
 *
 * That sample barely includes the in-session repair loop. Repair turns share the single attempt
 * deadline by design and are exactly the turns that extend toward the ceiling, so re-derive from the
 * same query once repair traffic exists.
 *
 * Anything higher than MAX_SAFE would require raising GENERATION_STALE_MS, which is a real change to
 * the invariants above rather than a tuning step, and nothing in the measured distribution asks for it.
 *
 * It is a DEFAULT rather than a required env var on purpose. A number that has to be set somewhere
 * to be correct is a number that is wrong in every environment nobody remembered — and agent turns
 * are exactly the low-traffic surface where nobody would notice for weeks.
 *
 * Not a licence to grow: past ~155s the answer is not a bigger ceiling. With `agent-run-handoff` on, a
 * run longer than one request is handed off before this fires (agentHandoffAt) and the page follows it
 * across requests, so this bounds one request's share of a run, not the run.
 */
export const DEFAULT_AGENT_GENERATION_TIMEOUT_MS = MAX_SAFE_GENERATION_TIMEOUT_MS;

/**
 * Watchdog default for a turn against a LOCAL (LAN/self-hosted, e.g. Ollama) model.
 * `LOCAL_GENERATION_TIMEOUT_MS` overrides it, clamped like every other rung.
 *
 * A local model's first turn against a cold instance pays real, unbounded model-LOAD time (weights
 * into memory) before it can produce a single byte — indistinguishable, to a plain total-time
 * watchdog, from a genuinely hung connection. DEFAULT_GENERATION_TIMEOUT_MS (45s) is sized against
 * measured PRIMARY-GATEWAY traffic (p99 ~20s, CUR-1194 audit) and has nothing to do with a self-hosted
 * box's own hardware or a cold daemon's load time — a real cold start on ordinary consumer hardware
 * measured well past 45s with zero bytes back (see the CUR-1194 timeout investigation). Reuses the
 * SAME ceiling agent turns already get rather than inventing a new number: it's the largest value the
 * ladder can safely allow without revisiting GENERATION_STALE_MS (see MAX_SAFE's own derivation above).
 *
 * Deliberately does NOT get its own SILENCE default the way the total cap does here: the silence
 * watchdog's activity clock (`state.lastActivityAt`, streamUpdate.ts) is bumped by every processed
 * MessageUpdate INCLUDING this app's own textGeneration/index.ts keepAlive() pulse, which fires every
 * 100ms independent of upstream state. That means the silence trigger practically never fires before
 * the total one on ANY turn (the local-model timeout fires with `trigger: "total"`, not
 * "silence") — raising SILENCE_TIMEOUT_MS's default for local turns would change nothing observable
 * and would just be one more number to keep synchronized with this one.
 */
export const DEFAULT_LOCAL_GENERATION_TIMEOUT_MS = MAX_SAFE_GENERATION_TIMEOUT_MS;

/**
 * The terminal path of an agent turn: everything between the agent stopping and the client seeing a
 * `done` frame — artifact collection, output moderation, the persist, delivery.
 *
 * Two terms, and the output screen is the one that dominates:
 *
 *   service side (agent's last frame → `done` frame)   ~40ms, and ~31ms of that WITH 20 artifacts
 *   our side     (one output-screen call, IF ENABLED)  p90 1,348ms · p99 1,901ms · max 2,028ms
 *
 * The service half comes from `evals/agent-tail-probe.mjs`: the gap between the last SSE frame and
 * the terminal frame, which is the terminal path itself and needs no wall-clock arithmetic. Artifact
 * collection is not a cost at all; 20 files come back in 31ms, because they are assembled into
 * `_done_payload` before the frame goes out.
 *
 * The second row is a latent worst case, not what production pays. The gate is at the wrap site in
 * conversation/[id]/+server.ts (`outputModerationEnabled() ? screenOutputStream(…) :
 * textGeneration(ctx)`), so it is path-agnostic, and with `OUTPUT_MODERATION` off screenOutputStream
 * runs on nothing, agent turns included. Its percentiles come from 368 turns of a synthetic load test.
 * What does run unconditionally is honestyScreenStream's final flush, and its checks are synchronous
 * and zero-network apart from one embedding call gated on `grounded`, which an agent turn, having no
 * retrieved sources, does not take. With screening off the terminal path is ~40ms plus a persist.
 *
 * 5s stays anyway, and the reason is the flag rather than the measurement: sizing this to
 * OUTPUT_MODERATION's CURRENT position would mean flipping that flag on silently breaks the deadline
 * reconciliation, in the direction that finishes a turn nobody is shown. So the tail is sized to the
 * worst SUPPORTED configuration — ~2.4× the 2.1s worst case with screening on — which is also still one
 * whole EMERGENCY_CLEANUP_BUDGET_MS, this file's unit for "one bounded DB or stream call". The
 * asymmetry that argued for generosity is unchanged (overestimating cuts an agent turn a little short
 * of the client's patience; underestimating produces a turn the service completes in full and nobody
 * is ever shown) — but it argues for headroom over a bound, not for a number 7× anything measured. The
 * 10s this returns to AGENT_SERVICE_WALL_CLOCK_SECS is agent working time, on the turns being cut off.
 *
 * `screenHoldMs` (p50 519ms, p90 1,070ms) still does NOT substitute, and it is worth keeping the
 * reason: textGeneration/index.ts gates it on `!genTimingLogged`, so it is stamped on the FIRST
 * released token and says nothing about the last one.
 *
 * Re-derive with `node evals/agent-tail-probe.mjs` if the terminal path changes — in particular if
 * output screening moves off a per-call model, which is the term that dominates.
 */
export const AGENT_TERMINAL_TAIL_MS = EMERGENCY_CLEANUP_BUDGET_MS;

/**
 * agent-service's own ceiling on one attempt (`AGENT_WALL_CLOCK_SECS` in agent-service/fly/agent-app.toml)
 * and how many attempts a task may make (`AGENT_BEST_OF` there). /healthz reports both, as
 * `wall_clock_s` and `wall_clock_task_s` (the product). Restated here because the chat side has to know
 * how long a run can last to keep following it; change both together.
 */
const AGENT_SERVICE_ATTEMPT_CEILING_SECS = 300;
/** @internal exported for the ladder spec */
export const AGENT_SERVICE_BEST_OF = 3;

/**
 * The wall-clock ceiling we ASK agent-service for — `wall_clock_secs` on its RunRequest.
 *
 *   AGENT_SERVICE_WALL_CLOCK_SECS = (agent generation watchdog − terminal tail) / 1000
 *
 * Send nothing and the service bounds one attempt at its own `AGENT_WALL_CLOCK_SECS` (300s) while
 * this client gives up at 155s. A turn can then legitimately run ~145s past the point anyone is still
 * listening: the user reads "the agent timed out before finishing the task" while the service works
 * on and persists a result no one is shown. The in-session repair loop, reachable from chat,
 * makes that gap routine: repair turns share the single attempt
 * deadline by design, so they are precisely the turns that extend toward 300s.
 *
 * The service clamps LOWER-ONLY, so this can shorten its ceiling and can never raise it; omitting the
 * field restores the old 300s behaviour, which is what the eval harness still gets.
 *
 * Derived from the DEFAULT rather than the resolved watchdog, which is exact while
 * AGENT_GENERATION_TIMEOUT_MS is unset (it is unset in production and preview) and
 * conservative otherwise: that env is clamped to MAX_SAFE and the default already IS MAX_SAFE, so it
 * can only lower the client's patience — reopening a strictly smaller version of this gap, never a
 * larger one. Plumbing the resolved value from conversation/[id]/+server.ts down to the endpoint
 * would close that, and is not worth it until someone sets the var.
 */
export const AGENT_SERVICE_WALL_CLOCK_SECS = Math.floor(
	(DEFAULT_AGENT_GENERATION_TIMEOUT_MS - AGENT_TERMINAL_TAIL_MS) / 1000
);

/**
 * The wall-clock ceiling we ask agent-service for when `agent-run-handoff` is on (agentRunHandoffGate.ts).
 *
 * The run is then not held inside one chat request: the turn streams it while its invocation lasts,
 * hands it off (agentHandoffAt) and the page re-attaches to it until it ends, so the run is bounded by
 * agent-service rather than by the 155s watchdog. AGENT_SERVICE_WALL_CLOCK_SECS above cuts every run
 * where the request gives up, which leaves a task longer than ~150s (a board pack) unfinishable. The
 * service clamps lower-only, so asking for its own one-attempt ceiling is the most it will give.
 */
export const AGENT_HANDOFF_WALL_CLOCK_SECS = AGENT_SERVICE_ATTEMPT_CEILING_SECS;

/**
 * How long before the route's watchdog an agent turn stops reading the run and hands it off to the
 * page. The run goes on in agent-service; the turn stores the answer as interrupted with the run's
 * handle still open, and the page re-attaches to it (CUR-993, CUR-3875).
 *
 * Three cleanup budgets: the endpoint notices the mark within one 4s heartbeat of the agent stream,
 * and the terminal path after it (AGENT_TERMINAL_TAIL_MS) and the persist need to land before the
 * watchdog would call the turn a timeout.
 *
 * @internal exported for the ladder spec
 */
export const AGENT_HANDOFF_MARGIN_MS = 3 * EMERGENCY_CLEANUP_BUDGET_MS;

/**
 * When an agent turn whose watchdog fires at `turnDeadlineAt` hands its run off, measured from `now`
 * (when the endpoint starts reading). AGENT_HANDOFF_MARGIN_MS before the deadline, but never earlier
 * than halfway there, so a short forced deadline (`agent_turn_deadline_20s`) still streams for a while.
 */
export function agentHandoffAt(turnDeadlineAt: number, now: number): number {
	return Math.max(turnDeadlineAt - AGENT_HANDOFF_MARGIN_MS, now + (turnDeadlineAt - now) / 2);
}

/** Worst-case wall clock for one admitted invocation, against which the platform kill is judged. */
export const MAX_INVOCATION_MS =
	PRESTREAM_CHAIN_DEADLINE_MS +
	MAX_SAFE_GENERATION_TIMEOUT_MS +
	HARD_UNWIND_GRACE_MS +
	EMERGENCY_TAIL_MS;

/**
 * How long a turn whose watchdog is `genTimeoutMs` may wait on its input screen before the
 * generation clock starts: up to MAX_INPUT_SCREEN_MS, and never so long that screen plus generation
 * passes MAX_SAFE_GENERATION_TIMEOUT_MS (CUR-3749).
 */
export function screenAllowanceMs(genTimeoutMs: number): number {
	return Math.max(0, Math.min(MAX_INPUT_SCREEN_MS, MAX_SAFE_GENERATION_TIMEOUT_MS - genTimeoutMs));
}

/** The guard screen's cap before CUR-3749. A turn whose generation clock gets no screen allowance
 *  (agent and local turns default to MAX_SAFE) keeps it, so a long paste costs their watchdog no more
 *  than it did. */
const UNEXTENDED_SCREEN_CAP_MS = 60_000;

/** Ceiling on the input screen's deadline for a turn with this generation timeout: the time the
 *  generation clock will wait for, or the old 60 s cap when that is shorter. */
export function screenDeadlineCapMs(genTimeoutMs: number): number {
	return Math.max(UNEXTENDED_SCREEN_CAP_MS, screenAllowanceMs(genTimeoutMs));
}

export interface ResolvedGenerationTimeout {
	/** What the environment asked for (or the default, when unset/unparseable). */
	requestedMs: number;
	/** What the ladder will actually allow. */
	effectiveMs: number;
	/** True when the clamp bit — worth a one-time warn at the call site. */
	clamped: boolean;
}

/**
 * Resolve the generation watchdog timeout from a raw env value, clamped to the ladder.
 *
 * `fallbackMs` is the default for the KIND of turn being resolved — DEFAULT_GENERATION_TIMEOUT_MS
 * for an ordinary one, DEFAULT_AGENT_GENERATION_TIMEOUT_MS for an agent one. It is clamped like any
 * other value, so a caller cannot smuggle a fallback past the ladder.
 *
 * These env vars change at deploy time without a code change, so no test can guard their ordering against the rest
 * of the ladder — `generationState.spec.ts` asserts against the source default, not against what
 * production actually has. The guard has to be runtime, and it has to sit at the effective read
 * site. The env var is therefore a REQUEST the ladder may refuse: a bad value degrades to a shorter
 * turn (visible, retryable) instead of a hung spinner (invisible, unretryable).
 *
 * A deploy IS required for a change to take effect — Vercel bakes env vars into a deployment and already-running instances keep the old
 * value until the next one (`config/env-manifest.mjs`, ENV_EXTRACT_SECRET, says the same). The
 * runtime guard is still the right shape; what it buys is a bad value being refused rather than a
 * bad value being impossible to ship.
 */
export function resolveGenerationTimeoutMs(
	raw: unknown,
	fallbackMs: number = DEFAULT_GENERATION_TIMEOUT_MS
): ResolvedGenerationTimeout {
	const parsed = Number(raw);
	const requestedMs = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
	const effectiveMs = Math.min(requestedMs, MAX_SAFE_GENERATION_TIMEOUT_MS);
	return { requestedMs, effectiveMs, clamped: effectiveMs < requestedMs };
}

/**
 * A model's own floor under the deployment-wide generation timeout (harnessProfiles.ts `generationTimeoutMs`,
 * CUR-4403). Raises the timeout to the floor and never lowers it; null keeps the deployment-wide value as it was.
 * The result goes through the same MAX_SAFE clamp as an env value, so the ladder still holds.
 */
export function withModelFloor(
	fleet: ResolvedGenerationTimeout,
	modelFloorMs: number | null
): ResolvedGenerationTimeout {
	if (modelFloorMs === null || modelFloorMs <= fleet.requestedMs) return fleet;
	return resolveGenerationTimeoutMs(modelFloorMs, fleet.requestedMs);
}

/**
 * Should the PRIMARY (silence) watchdog treat this generation as stalled right now? (CUR-1085)
 *
 * `awaitingConfirmation` is the one legitimate reason for a real stretch of zero tokens that isn't a
 * stall: agent-service paused a tool call on ACP_PERMISSION_POLICY=confirm and is waiting on a human's
 * Allow/Deny click. Without the exemption a turn is killed at exactly `silenceTimeoutMs` (45s)
 * while its confirm card is still on screen; agent-service keeps running regardless, but the SSE reader
 * is already gone, so the click has nowhere to deliver its answer.
 *
 * Deliberately does NOT touch the TOTAL backstop (the caller's separate `genTimeoutMs` timer, fired
 * unconditionally by `fireStall("total")` regardless of this function). A human who never answers, or
 * an agent-service that never emits `confirm_result`, must still be caught by that ceiling — this
 * predicate only tells the PRIMARY trigger that an open confirm is not evidence of a hang, never that
 * the turn may run unbounded. See the ladder invariants at the top of this file for why the backstop
 * cannot be relaxed the same way.
 */
export function isSilentStall(params: {
	now: number;
	lastActivityAt: number;
	silenceTimeoutMs: number;
	awaitingConfirmation: boolean;
}): boolean {
	if (params.awaitingConfirmation) return false;
	return params.now - params.lastActivityAt >= params.silenceTimeoutMs;
}

/**
 * How recent the last content token must be for a turn to count as still streaming when its total
 * cap arrives (CUR-4009). Twice the silence poll interval: a lane writing a long answer slowly sends
 * tokens far more often than this, and a lane that has gone quiet for longer is left to the cap.
 */
const STREAMING_RECENT_MS = 2 * SILENCE_CHECK_INTERVAL_MS;

/**
 * Whether a turn is still writing its answer at the moment its total cap fires (CUR-4009). Such a turn
 * gets the rest of the ladder's room instead of being cut mid-sentence; the silence watchdog still
 * ends it if the tokens stop. Model output only, so an agent's heartbeat or a turn that never produced
 * a token is not mistaken for an answer in progress.
 *
 * `lastModelOutputAt` is the model's last raw chunk, read before the honesty and screening buffers
 * (CUR-4188). Some models' untagged reasoning is held until `</think>`, and a reply with none is held whole,
 * so a turn can stream for 37 s without one visible token; `lastTokenAt` alone would cut it at the cap.
 */
export function isStillStreaming(params: {
	now: number;
	lastTokenAt: number | undefined;
	lastModelOutputAt?: number;
}): boolean {
	const last = Math.max(params.lastTokenAt ?? -Infinity, params.lastModelOutputAt ?? -Infinity);
	if (last === -Infinity) return false;
	return params.now - last < STREAMING_RECENT_MS;
}

/**
 * The oldest an agent run can be while a page still re-attaches to it (CUR-3875): agent-service's own
 * one-attempt ceiling (`AGENT_WALL_CLOCK_SECS`, 300s, for a caller that asks for no less) plus the
 * terminal tail. By then the service has ended the run, so the next attach replays its final answer
 * and a further one would show nothing new.
 */
export const AGENT_RUN_CEILING_MS = 300_000 + AGENT_TERMINAL_TAIL_MS;

/**
 * The same, with `agent-run-handoff` on: every attempt agent-service may make at its full one-attempt
 * ceiling (AGENT_HANDOFF_WALL_CLOCK_SECS), plus the terminal tail.
 */
export const AGENT_HANDOFF_RUN_CEILING_MS =
	AGENT_SERVICE_BEST_OF * AGENT_HANDOFF_WALL_CLOCK_SECS * 1000 + AGENT_TERMINAL_TAIL_MS;

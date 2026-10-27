import { describe, expect, test } from "vitest";

import {
	AGENT_HANDOFF_MARGIN_MS,
	AGENT_HANDOFF_RUN_CEILING_MS,
	AGENT_HANDOFF_WALL_CLOCK_SECS,
	AGENT_RUN_CEILING_MS,
	AGENT_SERVICE_BEST_OF,
	AGENT_SERVICE_WALL_CLOCK_SECS,
	AGENT_TERMINAL_TAIL_MS,
	agentHandoffAt,
	DEFAULT_AGENT_GENERATION_TIMEOUT_MS,
	DEFAULT_GENERATION_TIMEOUT_MS,
	DEFAULT_LOCAL_GENERATION_TIMEOUT_MS,
	EMERGENCY_CLEANUP_BUDGET_MS,
	EMERGENCY_TAIL_MS,
	GENERATION_STALE_MS,
	HARD_UNWIND_GRACE_MS,
	isSilentStall,
	isStillStreaming,
	MAX_INPUT_SCREEN_MS,
	MAX_INVOCATION_MS,
	MAX_SAFE_GENERATION_TIMEOUT_MS,
	MAX_TRACK_DURATION_MS,
	PLATFORM_MAX_DURATION_MS,
	PRESTREAM_CHAIN_DEADLINE_MS,
	resolveGenerationTimeoutMs,
	withModelFloor,
	screenAllowanceMs,
	screenDeadlineCapMs,
	SILENCE_CHECK_INTERVAL_MS,
} from "./deadlineLadder";

// Every assertion here is SYMBOLIC — relationships between rungs, never today's numbers. The point
// is that the ladder survives being retuned: raising one rung for a slower model must not silently
// invert an ordering some other rung's failure mode depends on.
describe("deadline ladder ordering", () => {
	test("a clamped generation, its unwind, and the pre-updatedAt cleanup fit inside the stale window", () => {
		// The invariant the clamp exists to hold. The `2 ×` is the terminal-Status boundedSettle plus
		// the bounded persist — the persist is what resets the staleness clock, so the third cleanup
		// step (finishGeneration) runs after the clock is already reset and is deliberately excluded.
		expect(
			MAX_SAFE_GENERATION_TIMEOUT_MS + HARD_UNWIND_GRACE_MS + 2 * EMERGENCY_CLEANUP_BUDGET_MS
		).toBeLessThanOrEqual(GENERATION_STALE_MS);
	});

	test("staleness fires before the client evicts the background-generation entry", () => {
		// Otherwise the "this generation is dead" signal never reaches the UI: the poller has already
		// dropped the entry and the spinner hangs forever (cold-lane 503 → infinite spinner).
		expect(GENERATION_STALE_MS).toBeLessThan(MAX_TRACK_DURATION_MS);
	});

	test("the whole invocation finishes before the platform kills it", () => {
		// A platform kill runs no catch/finally: no terminal update is persisted, nothing is cleaned
		// up, and the client is left spinning against a conversation that will never become terminal.
		expect(MAX_INVOCATION_MS).toBeLessThan(PLATFORM_MAX_DURATION_MS);
		expect(MAX_INVOCATION_MS).toBe(
			PRESTREAM_CHAIN_DEADLINE_MS +
				MAX_SAFE_GENERATION_TIMEOUT_MS +
				HARD_UNWIND_GRACE_MS +
				EMERGENCY_TAIL_MS
		);
	});

	test("the default generation timeout is itself within the clamp", () => {
		// A default that needed clamping would warn on every cold start.
		expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeLessThanOrEqual(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(DEFAULT_AGENT_GENERATION_TIMEOUT_MS).toBeLessThanOrEqual(
			MAX_SAFE_GENERATION_TIMEOUT_MS
		);
		expect(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS).toBeLessThanOrEqual(
			MAX_SAFE_GENERATION_TIMEOUT_MS
		);
	});

	// A local (LAN/self-hosted) model's cold-start load time has nothing to do with the
	// primary gateway's own measured latency, so it gets the SAME longer ceiling agent turns already
	// use — not a fresh, unvetted number of its own. (CUR-1194)
	test("the local-model default equals the agent default — the safe ceiling, not a new number", () => {
		expect(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS).toBe(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
		expect(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS).toBe(MAX_SAFE_GENERATION_TIMEOUT_MS);
	});

	test("an ordinary turn's deadline stays SHORTER than a local model's — the split is the point", () => {
		// Same reasoning as the agent split below: a hung ordinary (primary-gateway) turn should not
		// hold a spinner for as long as a local model legitimately might need to cold-start.
		expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeLessThan(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS);
	});

	test("the ceiling we ask agent-service for still leaves room for the terminal tail", () => {
		// The failure this names: the service bounds one attempt at its own 300s while this client
		// stops listening at the agent watchdog, so a turn runs to completion for nobody — the user
		// reads a timeout and the result is persisted unseen. Asking for less is the whole fix, and
		// asking for less than the watchdog is not sufficient: the tail between the agent stopping and
		// the client seeing `done` has to fit too.
		expect(AGENT_SERVICE_WALL_CLOCK_SECS * 1000 + AGENT_TERMINAL_TAIL_MS).toBeLessThanOrEqual(
			DEFAULT_AGENT_GENERATION_TIMEOUT_MS
		);
		// A tail of zero would satisfy the line above while budgeting nothing for the thing it names.
		expect(AGENT_TERMINAL_TAIL_MS).toBeGreaterThan(0);
	});

	test("with agent-run-handoff on, a run is not cut at the chat watchdog: we ask for the whole attempt", () => {
		// agent-service/fly/agent-app.toml AGENT_WALL_CLOCK_SECS, the most its lower-only clamp gives.
		expect(AGENT_HANDOFF_WALL_CLOCK_SECS).toBe(300);
		expect(AGENT_HANDOFF_WALL_CLOCK_SECS * 1000).toBeGreaterThan(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
	});

	test("an agent turn hands its run off before the watchdog, with the terminal tail and a heartbeat to spare", () => {
		// The endpoint notices the mark within one 4s heartbeat of the agent stream (endpointAgent.ts
		// HEARTBEAT_MS); after that the terminal path has to land before the watchdog calls it a timeout.
		const heartbeatMs = 4_000;
		const deadline = 1_000_000;
		const handoff = agentHandoffAt(deadline, deadline - DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
		expect(handoff + heartbeatMs + AGENT_TERMINAL_TAIL_MS).toBeLessThanOrEqual(deadline);
		expect(handoff).toBe(deadline - AGENT_HANDOFF_MARGIN_MS);
	});

	test("a short forced agent deadline hands off halfway, not before the run has streamed anything", () => {
		// `agent_turn_deadline_20s` gives the turn 20s; a 15s margin would hand off at 5s.
		expect(agentHandoffAt(20_000, 0)).toBe(10_000);
	});

	test("a page follows an agent run for as long as every attempt agent-service may make", () => {
		expect(AGENT_HANDOFF_RUN_CEILING_MS).toBeGreaterThanOrEqual(
			AGENT_SERVICE_BEST_OF * AGENT_HANDOFF_WALL_CLOCK_SECS * 1000 + AGENT_TERMINAL_TAIL_MS
		);
		// Off, the ceiling is what it was: one attempt plus the tail.
		expect(AGENT_RUN_CEILING_MS).toBe(300_000 + AGENT_TERMINAL_TAIL_MS);
	});

	test("an ordinary turn's deadline stays SHORTER than an agent turn's — the split is the point", () => {
		// If these ever converge, the split has silently collapsed back to one number and whichever
		// way it collapsed is a regression: at the agent's value a hung ordinary turn holds a spinner
		// ~3x longer for no gain, and at the ordinary value agent work that is already finished and
		// verified is killed (CUR-144).
		expect(DEFAULT_GENERATION_TIMEOUT_MS).toBeLessThan(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
	});

	test("every rung is positive and the cleanup tail is a whole number of budgets", () => {
		for (const ms of [
			PRESTREAM_CHAIN_DEADLINE_MS,
			EMERGENCY_CLEANUP_BUDGET_MS,
			HARD_UNWIND_GRACE_MS,
			GENERATION_STALE_MS,
			MAX_TRACK_DURATION_MS,
			MAX_SAFE_GENERATION_TIMEOUT_MS,
			PLATFORM_MAX_DURATION_MS,
		]) {
			expect(ms).toBeGreaterThan(0);
		}
		expect(EMERGENCY_TAIL_MS % EMERGENCY_CLEANUP_BUDGET_MS).toBe(0);
	});
});

// GENERATION_TIMEOUT_MS changes in Doppler with no deploy and no PR, so this resolver — not CI — is
// the only thing standing between a fat-fingered env value and a live turn declared dead mid-flight.
describe("resolveGenerationTimeoutMs", () => {
	test("passes a sane value through untouched", () => {
		const sane = MAX_SAFE_GENERATION_TIMEOUT_MS - 5_000;
		expect(resolveGenerationTimeoutMs(String(sane))).toEqual({
			requestedMs: sane,
			effectiveMs: sane,
			clamped: false,
		});
	});

	test("clamps an over-large value and reports that it did", () => {
		const tooBig = PLATFORM_MAX_DURATION_MS;
		const r = resolveGenerationTimeoutMs(String(tooBig));
		expect(r.requestedMs).toBe(tooBig);
		expect(r.effectiveMs).toBe(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(r.clamped).toBe(true);
	});

	test("the ceiling itself is allowed, unclamped", () => {
		const r = resolveGenerationTimeoutMs(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(r.effectiveMs).toBe(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(r.clamped).toBe(false);
	});

	test.each([
		["unset", undefined],
		["empty", ""],
		["non-numeric", "soon"],
		["zero", "0"],
		["negative", "-1000"],
		["NaN", Number.NaN],
	])("falls back to the default on a %s value", (_label, raw) => {
		const r = resolveGenerationTimeoutMs(raw);
		expect(r.effectiveMs).toBe(DEFAULT_GENERATION_TIMEOUT_MS);
		expect(r.clamped).toBe(false);
	});

	test("an unset ORDINARY turn does not inherit the agent's longer deadline", () => {
		// The silently-widening direction. The caller picks the fallback, so a refactor that drops the
		// second argument, or a shared `config` read that stops distinguishing the two env vars, would
		// hand every ordinary turn the agent ceiling — and nothing would look broken, because a longer
		// deadline never fails a test, it just holds hung turns open ~3x longer in production.
		expect(resolveGenerationTimeoutMs(undefined).effectiveMs).toBe(DEFAULT_GENERATION_TIMEOUT_MS);
		expect(resolveGenerationTimeoutMs(undefined).effectiveMs).not.toBe(
			DEFAULT_AGENT_GENERATION_TIMEOUT_MS
		);
	});

	test("an explicit fallback is used when the env value is absent, and is itself clamped", () => {
		// Agent turns rely on this: no AGENT_GENERATION_TIMEOUT_MS set anywhere, correct anyway.
		expect(resolveGenerationTimeoutMs(undefined, DEFAULT_AGENT_GENERATION_TIMEOUT_MS)).toEqual({
			requestedMs: DEFAULT_AGENT_GENERATION_TIMEOUT_MS,
			effectiveMs: DEFAULT_AGENT_GENERATION_TIMEOUT_MS,
			clamped: false,
		});
		// A fallback is not a way around the ladder — it clamps like any other value.
		const overLarge = resolveGenerationTimeoutMs(undefined, PLATFORM_MAX_DURATION_MS);
		expect(overLarge.effectiveMs).toBe(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(overLarge.clamped).toBe(true);
	});

	test("an env value still wins over the fallback for either turn kind", () => {
		const explicit = 30_000;
		expect(
			resolveGenerationTimeoutMs(String(explicit), DEFAULT_AGENT_GENERATION_TIMEOUT_MS)
				.effectiveMs
		).toBe(explicit);
	});
});

// A turn was killed by the silence watchdog while its agent-confirm card was still open —
// nobody had answered yet, which produces exactly the zero-token silence this watchdog exists to catch,
// for a reason that isn't a hang. isSilentStall is the guard; these pin its two failure directions. (CUR-1085)
describe("isSilentStall (CUR-1085)", () => {
	const silenceTimeoutMs = 45_000;

	test("a real stall past the threshold fires, same as before this ticket", () => {
		expect(
			isSilentStall({
				now: 100_000,
				lastActivityAt: 100_000 - silenceTimeoutMs,
				silenceTimeoutMs,
				awaitingConfirmation: false,
			})
		).toBe(true);
	});

	test("ordinary silence under the threshold does not fire", () => {
		expect(
			isSilentStall({
				now: 100_000,
				lastActivityAt: 100_000 - silenceTimeoutMs + 1,
				silenceTimeoutMs,
				awaitingConfirmation: false,
			})
		).toBe(false);
	});

	test("the exact shape that broke live: past the threshold, but a confirm card is open", () => {
		expect(
			isSilentStall({
				now: 100_000,
				lastActivityAt: 100_000 - silenceTimeoutMs - 1,
				silenceTimeoutMs,
				awaitingConfirmation: true,
			})
		).toBe(false);
	});

	test("an open confirm does not grant unlimited silence once it resolves", () => {
		// Same elapsed silence as the case above, confirmation flag flipped back off (what
		// streamUpdate.ts does on AgentConfirmResult) — must fire again like any other stall.
		expect(
			isSilentStall({
				now: 100_000,
				lastActivityAt: 100_000 - silenceTimeoutMs - 1,
				silenceTimeoutMs,
				awaitingConfirmation: false,
			})
		).toBe(true);
	});
});

// The generation clock starts when the input screen ends, so the screen's time is a new
// spend inside the invocation. It must come out of MAX_SAFE, or both invariants above break. (CUR-3749)
describe("screenAllowanceMs: the input screen's time never pushes a turn past MAX_SAFE", () => {
	test("screen plus generation stays inside MAX_SAFE for every watchdog the ladder allows", () => {
		for (let gen = 1_000; gen <= MAX_SAFE_GENERATION_TIMEOUT_MS; gen += 1_000) {
			expect(gen + screenAllowanceMs(gen)).toBeLessThanOrEqual(MAX_SAFE_GENERATION_TIMEOUT_MS);
		}
	});

	test("an ordinary turn's 45s leaves the whole screen budget, so a 100k paste is not cut short", () => {
		expect(screenAllowanceMs(DEFAULT_GENERATION_TIMEOUT_MS)).toBe(MAX_INPUT_SCREEN_MS);
	});

	test("an agent or local turn, already at MAX_SAFE, gets no extension and screens inside its own budget", () => {
		expect(screenAllowanceMs(DEFAULT_AGENT_GENERATION_TIMEOUT_MS)).toBe(0);
		expect(screenAllowanceMs(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS)).toBe(0);
	});
});

describe("screenDeadlineCapMs: a turn whose clock won't wait for the screen keeps the old cap", () => {
	test("an ordinary turn's screen may run as long as its generation clock waits", () => {
		expect(screenDeadlineCapMs(DEFAULT_GENERATION_TIMEOUT_MS)).toBe(screenAllowanceMs(DEFAULT_GENERATION_TIMEOUT_MS));
	});

	test("an agent or local turn's screen keeps a shorter cap than the ordinary turn's, and a nonzero one", () => {
		const agentCap = screenDeadlineCapMs(DEFAULT_AGENT_GENERATION_TIMEOUT_MS);
		expect(agentCap).toBeGreaterThan(0);
		expect(agentCap).toBeLessThan(MAX_INPUT_SCREEN_MS);
		expect(screenDeadlineCapMs(DEFAULT_LOCAL_GENERATION_TIMEOUT_MS)).toBe(agentCap);
	});
});

describe("isStillStreaming: only a turn with a recent token gets the CUR-4009 extension", () => {
	test("a token 3s ago is still streaming", () => {
		expect(isStillStreaming({ now: 50_000, lastTokenAt: 47_000 })).toBe(true);
	});
	test("a token two silence checks old is not, so a stalled stream is still cut at the cap", () => {
		expect(isStillStreaming({ now: 50_000, lastTokenAt: 50_000 - 2 * SILENCE_CHECK_INTERVAL_MS })).toBe(false);
	});
	test("no token at all (still waiting on the first) is not streaming", () => {
		expect(isStillStreaming({ now: 50_000, lastTokenAt: undefined })).toBe(false);
	});
	// A model can hold 37 s of output with no visible token yet (CUR-4188).
	test("held model output 1s ago with no visible token yet still counts as streaming", () => {
		expect(isStillStreaming({ now: 45_000, lastTokenAt: undefined, lastModelOutputAt: 44_000 })).toBe(true);
	});
	test("held model output that stopped two silence checks ago does not", () => {
		expect(
			isStillStreaming({
				now: 45_000,
				lastTokenAt: undefined,
				lastModelOutputAt: 45_000 - 2 * SILENCE_CHECK_INTERVAL_MS,
			})
		).toBe(false);
	});
});

describe("withModelFloor (CUR-4403)", () => {
	const fleet = resolveGenerationTimeoutMs(undefined, DEFAULT_GENERATION_TIMEOUT_MS);

	test("keeps the fleet value byte for byte for a model with no floor of its own", () => {
		expect(withModelFloor(fleet, null)).toBe(fleet);
	});

	test("raises the 45s fleet default to a model's 60s floor", () => {
		expect(withModelFloor(fleet, 60_000)).toEqual({ requestedMs: 60_000, effectiveMs: 60_000, clamped: false });
	});

	test("never lowers a fleet value already past the floor", () => {
		const raised = resolveGenerationTimeoutMs("90000");
		expect(withModelFloor(raised, 60_000)).toBe(raised);
	});

	test("clamps a floor past the ladder's ceiling to MAX_SAFE, as it does an env value", () => {
		const r = withModelFloor(fleet, MAX_SAFE_GENERATION_TIMEOUT_MS + 10_000);
		expect(r.effectiveMs).toBe(MAX_SAFE_GENERATION_TIMEOUT_MS);
		expect(r.clamped).toBe(true);
	});
});

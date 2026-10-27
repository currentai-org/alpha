import { describe, it, expect, vi } from "vitest";
import {
	withFailover,
	createHedgeThrottle,
	firstChunkTimings,
	laneModelIds,
	NoFirstChunkError,
} from "./failover";
import { MessageTooLongError } from "./openai/fitHistory";
import { ToolRoundHandoff } from "./openai/calculateTool";
import type { Endpoint, EndpointParameters, TextGenerationStreamOutputSimplified } from "./types";

// The busy mark's writes go to the database; these specs read which turns would have counted (CUR-4098).
const busy = vi.hoisted(() => ({ noteFailed: vi.fn(), noteAnswered: vi.fn() }));
vi.mock("$lib/chat/server/modelBusy", () => busy);

// Minimal stand-in for a streamed chunk — the wrapper is agnostic to the payload shape, it only cares
// about WHEN the first value arrives vs. when an error is thrown.
const chunk = (text: string): TextGenerationStreamOutputSimplified =>
	({
		token: { id: 0, text, logprob: 0, special: false },
		generated_text: null,
	}) as unknown as TextGenerationStreamOutputSimplified;

const params = {} as EndpointParameters;

// A lane that yields the given chunks then completes.
const laneYielding =
	(...texts: string[]): Endpoint =>
	async () =>
		(async function* () {
			for (const t of texts) yield chunk(t);
		})();

// A lane that rejects when invoked (e.g. the OpenAI client throws before returning a generator).
const laneThrowsOnInvoke =
	(msg: string): Endpoint =>
	async () => {
		throw new Error(msg);
	};

// A lane whose generator throws on the first pull (connection opened then died pre-token).
const laneThrowsBeforeFirst =
	(msg: string): Endpoint =>
	async () =>
		(async function* () {
			// `if (msg) throw` rather than a bare `throw` so this needs NO eslint directive. The two
			// configs over this file want opposite things: lint:quality's no-unreachable rejects a yield
			// after an unconditional throw, and the main config's require-yield rejects a generator
			// without one. A conditional throw satisfies both, and msg is always a non-empty string, so
			// the behaviour is unchanged: this still dies on the first pull with nothing yielded.
			//
			// A bare throw needs a no-unreachable disable, which the main config reports as UNUSED, so --fix deletes
			// it and lint:quality goes red (CUR-219). Needing no directive keeps that from recurring.
			if (msg) throw new Error(msg);
			yield chunk("never");
		})();

// A lane that yields one chunk, THEN dies mid-stream.
const laneDiesMidStream =
	(firstText: string, msg: string): Endpoint =>
	async () =>
		(async function* () {
			yield chunk(firstText);
			throw new Error(msg);
		})();

// A lane that throws on invoke for its first N calls, then succeeds — the shape a genuinely transient
// failure takes (a timeout that clears), as opposed to laneThrowsOnInvoke's permanently-dead lane.
const laneThrowsThenRecovers = (failCount: number, msg: string, ...texts: string[]): Endpoint => {
	let calls = 0;
	return async () => {
		calls++;
		if (calls <= failCount) throw new Error(msg);
		return (async function* () {
			for (const t of texts) yield chunk(t);
		})();
	};
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A lane whose Nth invocation behaves differently — the shape a hedge actually meets in production,
// where the same lane is a pool and the second attempt lands on a different backend. The last plan
// repeats if the lane is called more times than there are plans.
const laneByCall = (...plans: { delayMs: number; text: string }[]): Endpoint => {
	let calls = 0;
	return async () => {
		const plan = plans[Math.min(calls++, plans.length - 1)];
		return (async function* () {
			await sleep(plan.delayMs);
			yield chunk(plan.text);
		})();
	};
};

// Same, but records which attempts ran their `finally`. A generator suspended at a `yield` reaches
// `finally` only when someone calls `return()` on it, so this is a direct read of whether the loser
// was actually cancelled rather than left holding an open response.
const laneByCallTracked = (...plans: { delayMs: number; text: string }[]) => {
	const closed: string[] = [];
	let calls = 0;
	const lane: Endpoint = async () => {
		const plan = plans[Math.min(calls++, plans.length - 1)];
		return (async function* () {
			try {
				await sleep(plan.delayMs);
				yield chunk(plan.text);
			} finally {
				closed.push(plan.text);
			}
		})();
	};
	return { lane, closed };
};

async function collect(ep: Endpoint): Promise<string[]> {
	const gen = await ep(params);
	const out: string[] = [];
	for await (const v of gen) out.push(v.token.text);
	return out;
}


// A lane whose FIRST call NEVER produces a first chunk — not slow, never — recording the AbortSignal
// each call was handed. Every other hedge helper here uses a loser that eventually resolves, which is
// exactly the case the promise-attached cancellation already covered; this is the one it cannot reach.
const laneNeverSettlesThenRecovers = (text: string) => {
	const signals: (AbortSignal | undefined)[] = [];
	let calls = 0;
	const lane: Endpoint = async (p) => {
		signals.push((p as EndpointParameters).abortSignal);
		const n = calls++;
		return (async function* () {

			if (n === 0) await new Promise(() => {});
			yield chunk(text);
		})();
	};
	return { lane, signals };
};

describe("withFailover", () => {
	it("returns the single lane unchanged when only one is configured", () => {
		const only = laneYielding("a");
		expect(withFailover([only])).toBe(only); // identity — zero behavior change for single-endpoint models
	});

	it("throws if given no lanes", () => {
		expect(() => withFailover([])).toThrow(/at least one/i);
	});

	it("fails over to the backup when the primary rejects on invoke (pre-output)", async () => {
		const backup = vi.fn(laneYielding("from-hf"));
		const ep = withFailover([laneThrowsOnInvoke("cscs down"), backup]);
		expect(await collect(ep)).toEqual(["from-hf"]);
		expect(backup).toHaveBeenCalledOnce();
	});

	it("fails over when the primary dies before its first token", async () => {
		const ep = withFailover([laneThrowsBeforeFirst("no token"), laneYielding("hf-a", "hf-b")]);
		expect(await collect(ep)).toEqual(["hf-a", "hf-b"]);
	});

	it("does NOT fail over once the primary has produced output — the error propagates", async () => {
		const backup = vi.fn(laneYielding("should-not-run"));
		const ep = withFailover([laneDiesMidStream("partial", "mid-stream death"), backup]);
		const gen = await ep(params);
		const seen: string[] = [];
		await expect(
			(async () => {
				for await (const v of gen) seen.push(v.token.text);
			})()
		).rejects.toThrow(/mid-stream death/);
		expect(seen).toEqual(["partial"]); // the partial output was delivered
		expect(backup).not.toHaveBeenCalled(); // never splice in a second lane after committing
	});

	it("never touches the backup when the primary succeeds", async () => {
		const backup = vi.fn(laneYielding("hf"));
		const ep = withFailover([laneYielding("cscs-1", "cscs-2"), backup]);
		expect(await collect(ep)).toEqual(["cscs-1", "cscs-2"]);
		expect(backup).not.toHaveBeenCalled();
	});

	it("surfaces the last error when every lane fails pre-output", async () => {
		const ep = withFailover([
			laneThrowsOnInvoke("cscs down"),
			laneThrowsBeforeFirst("hf down too"),
		]);
		await expect(collect(ep)).rejects.toThrow(/hf down too/);
	});

	it("walks through three lanes, committing to the first that produces output", async () => {
		const third = vi.fn(laneYielding("third"));
		const ep = withFailover([laneThrowsOnInvoke("a down"), laneYielding("second"), third]);
		expect(await collect(ep)).toEqual(["second"]);
		expect(third).not.toHaveBeenCalled(); // stop at the first working lane
	});

	// A lane that comes back with zero chunks produced no answer, which is the lost-turn symptom, so
	// it fails over rather than counting as a clean completion. (CUR-1344)
	it("a lane completing with zero chunks FAILS OVER — an empty answer is a lost turn, not a clean finish", async () => {
		const backup = vi.fn(laneYielding("hf"));
		const ep = withFailover([laneYielding(), backup]); // primary completes with no chunks
		expect(await collect(ep)).toEqual(["hf"]);
		expect(backup).toHaveBeenCalled();
	});

	it("surfaces the empty-completion error when EVERY lane comes back with zero chunks", async () => {
		const ep = withFailover([laneYielding(), laneYielding()]);
		await expect(collect(ep)).rejects.toThrow(/zero-token answer is a lost turn/);
	});
});

describe("CUR-1210: retry the SAME lane before falling over to a different model", () => {
	it("recovers from a transient primary failure WITHOUT ever touching the backup model", async () => {
		const primary = vi.fn(laneThrowsThenRecovers(1, "transient timeout", "apertus-answer"));
		const backup = vi.fn(laneYielding("glm-answer"));
		const ep = withFailover([primary, backup]);

		expect(await collect(ep)).toEqual(["apertus-answer"]);
		expect(primary).toHaveBeenCalledTimes(2); // failed once, retried once, succeeded
		expect(backup).not.toHaveBeenCalled(); // never fell over — the model identity never changed
	});

	it("still falls over once the SAME lane's retry budget is exhausted — same as before this change", async () => {
		const primary = vi.fn(laneThrowsOnInvoke("cscs down for real"));
		const backup = vi.fn(laneYielding("glm-answer"));
		const ep = withFailover([primary, backup]);

		expect(await collect(ep)).toEqual(["glm-answer"]);
		expect(primary).toHaveBeenCalledTimes(2); // both attempts spent before advancing
		expect(backup).toHaveBeenCalledOnce();
	});

	it("bounds the retry — never calls one lane more than the configured attempts, even on the last lane", async () => {
		const only = vi.fn(laneThrowsOnInvoke("down"));
		const ep = withFailover([only, vi.fn(laneThrowsOnInvoke("also down"))]);
		await expect(collect(ep)).rejects.toThrow(/also down/);
		expect(only).toHaveBeenCalledTimes(2);
	});
});

describe("CUR-1344: a hung lane never throws, so hedge on first token instead of retrying after it", () => {
	it("serves the turn from a hedged second attempt when the first produces no first chunk", async () => {
		const lane = laneByCall({ delayMs: 400, text: "stalled" }, { delayMs: 5, text: "hedged" });
		const backup = vi.fn(laneYielding("backup-model"));
		const ep = withFailover([lane, backup], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		expect(await collect(ep)).toEqual(["hedged"]);
		// CUR-1210's invariant still holds: a hedge is a SAME-lane attempt, so the different-model
		// backup is no closer than a sequential retry would have put it.
		expect(backup).not.toHaveBeenCalled();
	});

	// The distinction the whole change turns on. Envoy's hedge issues a retry "without resetting the
	// original request"; a per-try timeout that cancelled and retried would throw away a prefill that
	// was about to land. Here the original answers 10ms AFTER the hedge fires — under cancel-and-retry
	// this returns "hedged", and the only way it returns "original" is if the first was left running.
	it("does not reset the original — an original that answers after the hedge fired still wins", async () => {
		const lane = laneByCall({ delayMs: 40, text: "original" }, { delayMs: 400, text: "hedged" });
		const ep = withFailover([lane], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		expect(await collect(ep)).toEqual(["original"]);
	});

	it("abandons the losing attempt rather than leaving its response open", async () => {
		const { lane, closed } = laneByCallTracked(
			{ delayMs: 120, text: "stalled" },
			{ delayMs: 5, text: "hedged" }
		);
		const ep = withFailover([lane], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		expect(await collect(ep)).toEqual(["hedged"]);
		await sleep(250);
		expect(closed).toContain("stalled");
	});

	it("with hedging off, a slow lane is simply waited on — the flag's off position is inert", async () => {
		const lane = laneByCall({ delayMs: 30, text: "slow" }, { delayMs: 1, text: "hedged" });
		const ep = withFailover([lane, laneYielding("backup-model")]);
		expect(await collect(ep)).toEqual(["slow"]);
	});

	it("never invokes a lane more than the same-lane attempt budget, hedges included", async () => {
		let calls = 0;
		const counted: Endpoint = async () => {
			calls++;
			return (async function* () {
				await sleep(60);
				yield chunk("served");
			})();
		};
		const ep = withFailover([counted, laneYielding("backup-model")], {
			hedgeDelayMs: 5,
			throttle: createHedgeThrottle(),
		});
		expect(await collect(ep)).toEqual(["served"]);
		expect(calls).toBe(2);
	});

	it("stops hedging once the throttle is drained, so an outage cannot double the request rate", async () => {
		const throttle = createHedgeThrottle();
		for (let i = 0; i < 6; i++) throttle.record(false);
		let calls = 0;
		const lane: Endpoint = async () => {
			calls++;
			return (async function* () {
				await sleep(40);
				yield chunk("served");
			})();
		};
		const ep = withFailover([lane], { hedgeDelayMs: 1, throttle });
		expect(await collect(ep)).toEqual(["served"]);
		expect(calls).toBe(1);
	});

	it("the throttle only reopens after enough successes to climb back over half the bucket", () => {
		const throttle = createHedgeThrottle(10, 0.1);
		expect(throttle.allows()).toBe(true);
		for (let i = 0; i < 6; i++) throttle.record(false);
		expect(throttle.allows()).toBe(false);
		for (let i = 0; i < 10; i++) throttle.record(true);
		expect(throttle.allows()).toBe(false);
		for (let i = 0; i < 12; i++) throttle.record(true);
		expect(throttle.allows()).toBe(true);
	});
});

describe("CUR-1658: a hedge loser whose first pull never settles is never cancelled", () => {
	it("cuts an attempt started while the turn's signal is ALREADY aborted", async () => {
		// addEventListener only fires on a FUTURE transition, so chaining by listener alone leaves an
		// attempt started after the turn was cancelled with a controller nothing will ever abort — this
		// ticket's own bug, one level over.
		//
		// Deliberately ONE attempt that never loses: hedging is off and the lane never settles, so
		// cutAllBut's winner-branch can't reach it and the chain is the only thing that can abort it.
		// Asserting this on the hedge LOSER would prove nothing: cutAllBut aborts it either way, so the
		// test would pass with the guard removed.
		const signals: (AbortSignal | undefined)[] = [];
		const lane: Endpoint = async (p) => {
			signals.push((p as EndpointParameters).abortSignal);
			return (async function* () {

				await new Promise(() => {});
				yield chunk("never");
			})();
		};
		const ac = new AbortController();
		ac.abort();
		const ep = withFailover([lane], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		const gen = await ep({ ...params, abortSignal: ac.signal } as EndpointParameters);
		// Kick it without awaiting — nothing in this lane ever settles on its own.
		void gen.next().catch(() => {});
		await sleep(30);
		expect(signals[0], "no attempt was ever opened, so this test proves nothing").toBeDefined();
		expect(
			signals[0]?.aborted,
			"an attempt launched under an already-aborted turn signal was never cut — a listener attached after the signal aborted never fires"
		).toBe(true);
	});

	it("cuts the losing attempt's request even though its openLane promise never settles", async () => {
		const { lane, signals } = laneNeverSettlesThenRecovers("hedged");
		const ep = withFailover([lane], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		expect(await collect(ep)).toEqual(["hedged"]);
		await sleep(50);
		expect(
			signals[0],
			"the first attempt was handed no AbortSignal at all, so nothing could ever cut it"
		).toBeDefined();
		expect(
			signals[0]?.aborted,
			"the losing attempt's request was never cut — its openLane promise never settles, so the .then() that calls abandon() never runs and the response stays open"
		).toBe(true);
		// The winner is still streaming to the caller, so cutting it would be the opposite bug.
		expect(signals[1]?.aborted, "the WINNING attempt was cut — it is still streaming").toBe(false);
	});
});

// The preview fault a spec uses to put the backup lane in front of a visitor (CUR-1933). It has to
// reach the backup without calling the primary at all, and it has to be inert with no backup.
describe("primary_lane_down fault", () => {
	const faulted = { failPrimaryLane: true } as EndpointParameters;

	it("serves the turn from the backup lane and never calls the primary", async () => {
		const primary = vi.fn(laneYielding("apertus"));
		const ep = withFailover([primary, laneYielding("glm")]);
		const out: string[] = [];
		for await (const v of await ep(faulted)) out.push(v.token.text);
		expect(out).toEqual(["glm"]);
		expect(primary).not.toHaveBeenCalled();
	});

	it("leaves a single-lane model serving, since there is nothing to fail over to", async () => {
		const ep = withFailover([laneYielding("apertus")]);
		const out: string[] = [];
		for await (const v of await ep(faulted)) out.push(v.token.text);
		expect(out).toEqual(["apertus"]);
	});
});

// The contract (CUR-2239): before a backup serving a DIFFERENT model starts, the stream says which
// model it replaces, which one takes over and why, so the live log and the receipt can show both.
// Nothing else names the backup until its own first chunk.
describe("CUR-2239: a cross-model backup is announced, with the model it replaces, before it answers", () => {
	const APERTUS = "swiss-ai/apertus-v1.5-70b";
	const GLM = "zai-org/GLM-5.3";
	const drain = async (ep: Endpoint, p: EndpointParameters = params) => {
		const out: { text: string; model?: string; failover?: unknown }[] = [];
		for await (const v of await ep(p)) {
			out.push({
				text: v.token.text,
				model: v.routerMetadata?.model,
				...(v.failover ? { failover: v.failover } : {}),
			});
		}
		return out;
	};

	it("announces the switch ahead of the backup's first chunk when the primary fails", async () => {
		const ep = withFailover([laneThrowsOnInvoke("down"), laneYielding("Bern")], {
			laneModels: [APERTUS, GLM],
		});
		expect(await drain(ep)).toEqual([
			{
				text: "",
				model: GLM,
				failover: { from: APERTUS, to: GLM, reason: "unavailable", cause: "error" },
			},
			{ text: "Bern", model: undefined },
		]);
	});

	it("says the primary was skipped, not that it failed, on the primary_lane_down fault", async () => {
		const ep = withFailover([laneYielding("apertus"), laneYielding("glm")], {
			laneModels: [APERTUS, GLM],
		});
		const out = await drain(ep, { failPrimaryLane: true } as EndpointParameters);
		expect(out[0]).toEqual({
			text: "",
			model: GLM,
			failover: { from: APERTUS, to: GLM, reason: "skipped" },
		});
		expect(out.map((o) => o.text)).toEqual(["", "glm"]);
	});

	it("announces nothing when the primary answers, so a healthy turn is untouched", async () => {
		const ep = withFailover([laneYielding("apertus"), laneYielding("glm")], {
			laneModels: [APERTUS, GLM],
		});
		expect(await drain(ep)).toEqual([{ text: "apertus", model: undefined }]);
	});

	it("announces nothing for a same-model backup lane, whose name would not change", async () => {
		const ep = withFailover([laneThrowsOnInvoke("down"), laneYielding("apertus")], {
			laneModels: [APERTUS, APERTUS],
		});
		expect(await drain(ep)).toEqual([{ text: "apertus", model: undefined }]);
	});
});

// CUR-2316. A primary that never sends headers never throws, so the ladder above never reaches the
// backup: with or without the same-lane hedge, the turn waits on the primary until something outside
// this file ends it (the output screen's 25s no-token deadline, then the 45s watchdog). The deadline
// below moves a silent lane's turn to the next lane while the visitor is still waiting.
describe("CUR-2316: a primary that sends no headers moves to the backup lane", () => {
	const hung = { hangPrimaryLane: true } as EndpointParameters;
	const firstWithin = async (ep: Endpoint, p: EndpointParameters, ms: number) => {
		const gen = await ep(p);
		const pull = gen.next().then((r) => (r.done ? "done" : r.value.token.text));
		const out = await Promise.race([pull, sleep(ms).then(() => "nothing yet")]);
		void gen.return(undefined).catch(() => {});
		return out;
	};

	it("with no deadline set, holds the turn on a headerless primary and never calls the backup", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneYielding("apertus"), backup]);
		expect(await firstWithin(ep, hung, 150)).toBe("nothing yet");
		expect(backup).not.toHaveBeenCalled();
	});

	it("with no deadline set, the same-lane hedge does not reach the backup either", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneYielding("apertus"), backup], {
			hedgeDelayMs: 10,
			throttle: createHedgeThrottle(),
		});
		expect(await firstWithin(ep, hung, 150)).toBe("nothing yet");
		expect(backup).not.toHaveBeenCalled();
	});

	it("when the turn is ended while the primary is silent, calls no backup and announces no failover", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneYielding("apertus"), backup], {
			laneModels: ["mistral-large-2512", "mistral-medium-2604"],
		});
		const ac = new AbortController();
		const gen = await ep({ ...hung, abortSignal: ac.signal } as EndpointParameters);
		const seen: TextGenerationStreamOutputSimplified[] = [];
		const drained = (async () => {
			for await (const v of gen) seen.push(v);
		})();
		await sleep(20);
		ac.abort();
		await expect(drained).rejects.toThrow(/no headers/);
		expect(backup).not.toHaveBeenCalled();
		expect(seen.filter((v) => v.failover)).toEqual([]);
	});

	it("serves the turn from the backup once the primary has sent nothing for failoverAfterMs", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneYielding("apertus"), backup], { failoverAfterMs: 30 });
		expect(await firstWithin(ep, hung, 500)).toBe("glm");
		expect(backup).toHaveBeenCalledTimes(1);
	});

	it("also moves on when the hedge is on, so a hedged pair of silent attempts cannot hold the turn", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneYielding("apertus"), backup], {
			failoverAfterMs: 40,
			hedgeDelayMs: 10,
			throttle: createHedgeThrottle(),
		});
		expect(await firstWithin(ep, hung, 500)).toBe("glm");
	});

	it("cuts the silent primary's request when it moves on, rather than leaving it open", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const silent: Endpoint = (p) => {
			signals.push(p.abortSignal);

			return new Promise(() => {});
		};
		const ep = withFailover([silent, laneYielding("glm")], { failoverAfterMs: 20 });
		expect(await collect(ep)).toEqual(["glm"]);
		expect(signals[0], "the primary was handed no signal, so nothing could cut it").toBeDefined();
		expect(signals[0]?.aborted, "the silent primary's request was left open").toBe(true);
	});

	it("keeps a primary that answers inside the deadline, so a healthy turn never changes model", async () => {
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([laneByCall({ delayMs: 10, text: "apertus" }), backup], {
			failoverAfterMs: 200,
		});
		expect(await collect(ep)).toEqual(["apertus"]);
		expect(backup).not.toHaveBeenCalled();
	});

	it("gives the last lane no failoverAfterMs deadline, which has nothing behind it to move to", async () => {
		const ep = withFailover([laneThrowsOnInvoke("down"), laneByCall({ delayMs: 60, text: "glm" })], {
			failoverAfterMs: 20,
		});
		expect(await collect(ep)).toEqual(["glm"]);
	});

	// A silent backup (CUR-3750) with no deadline of its own, as the last lane, would hold a turn the
	// primary had already given up on until the 45s watchdog fired.
	it("moves a turn past a silent backup to the lane behind it, so a second backup gets the turn", async () => {
		const silentBackup = vi.fn<Endpoint>(() => new Promise(() => {}));
		const ep = withFailover([laneThrowsOnInvoke("down"), silentBackup, laneYielding("qwen")], {
			failoverAfterMs: 20,
		});
		expect(await collect(ep)).toEqual(["qwen"]);
		expect(silentBackup).toHaveBeenCalled();
	});

	it("announces the switch as unavailable, not skipped, since the primary was really tried", async () => {
		const ep = withFailover([laneYielding("apertus"), laneYielding("glm")], {
			failoverAfterMs: 20,
			laneModels: ["swiss-ai/apertus-v1.5-70b", "zai-org/GLM-5.3"],
		});
		const gen = await ep(hung);
		const first = await gen.next();
		expect(first.done ? undefined : first.value.failover?.reason).toBe("unavailable");
		void gen.return(undefined).catch(() => {});
	});
});

// CUR-2346. A rate-limited lane is refused for the rest of its window, so a same-lane retry 100–300ms
// later spends another request of the shared cap and fails the same way. With a lane behind it, the turn
// moves on after one attempt; the last lane keeps its retry because there is nowhere else to go.
describe("CUR-2346: a 429 moves the turn to the next lane without a same-lane retry", () => {
	const laneRateLimited = (): Endpoint => async () => {
		throw Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
	};
	const LARGE3 = "mistral-large-2512";
	const GLM52 = "zai-org/GLM-5.2";

	it("calls a rate-limited primary once, then serves the backup and announces the switch", async () => {
		const primary = vi.fn(laneRateLimited());
		const backup = vi.fn(laneYielding("Bern"));
		const ep = withFailover([primary, backup], { laneModels: [LARGE3, GLM52] });
		const out: { text: string; failover?: unknown }[] = [];
		for await (const v of await ep(params)) {
			out.push({ text: v.token.text, ...(v.failover ? { failover: v.failover } : {}) });
		}
		expect(out).toEqual([
			{ text: "", failover: { from: LARGE3, to: GLM52, reason: "unavailable", cause: "rate-limited" } },
			{ text: "Bern" },
		]);
		expect(primary).toHaveBeenCalledOnce();
		expect(backup).toHaveBeenCalledOnce();
	});

	it("does the same with hedging on: no refill attempt at a rate-limited lane that has a backup", async () => {
		const primary = vi.fn(laneRateLimited());
		const backup = vi.fn(laneYielding("Bern"));
		const ep = withFailover([primary, backup], {
			hedgeDelayMs: 50,
			throttle: createHedgeThrottle(),
		});
		expect(await collect(ep)).toEqual(["Bern"]);
		expect(primary).toHaveBeenCalledOnce();
	});

	it("still retries a rate-limited LAST lane once, since no lane is left to move to", async () => {
		const primary = vi.fn(laneThrowsOnInvoke("down"));
		const last = vi.fn(laneRateLimited());
		const ep = withFailover([primary, last]);
		await expect(collect(ep)).rejects.toMatchObject({ status: 429 });
		expect(last).toHaveBeenCalledTimes(2);
	});

	it("keeps the same-lane retry for errors that are not a 429", async () => {
		const primary = vi.fn(laneThrowsThenRecovers(1, "transient timeout", "large3-answer"));
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([primary, backup]);
		expect(await collect(ep)).toEqual(["large3-answer"]);
		expect(primary).toHaveBeenCalledTimes(2);
		expect(backup).not.toHaveBeenCalled();
	});

	it("the primary_lane_rate_limited fault takes the same path: primary never called, backup answers", async () => {
		const primary = vi.fn(laneYielding("large3"));
		const backup = vi.fn(laneYielding("glm"));
		const ep = withFailover([primary, backup], { laneModels: [LARGE3, GLM52] });
		const texts: string[] = [];
		for await (const v of await ep({ rateLimitPrimaryLane: true } as EndpointParameters)) {
			texts.push(v.token.text);
		}
		expect(texts).toEqual(["", "glm"]);
		expect(primary).not.toHaveBeenCalled();
		expect(backup).toHaveBeenCalledOnce();
	});
});

// CUR-3313. When Large 3 sends nothing for 12s and Mistral Medium answers, the persisted failover
// names the cause, so each one has to come out as itself, never as the default.
describe("CUR-3313: the failover record names why the primary gave up", () => {
	const LARGE3 = "mistral-large-2512";
	const MEDIUM = "mistral-medium-2604";
	const causeOf = async (primary: Endpoint, opts: Parameters<typeof withFailover>[1] = {}) => {
		const ep = withFailover([primary, laneYielding("answer")], { laneModels: [LARGE3, MEDIUM], ...opts });
		for await (const v of await ep(params)) {
			if (v.failover) return v.failover.cause;
		}
		throw new Error("no failover announced");
	};

	it("says no-first-chunk when the primary was silent past the failover deadline", async () => {

		const silent: Endpoint = () => new Promise(() => {});
		expect(await causeOf(silent, { failoverAfterMs: 20 })).toBe("no-first-chunk");
	});

	it("says no-first-chunk on the hedged path too, where two silent attempts ran out the deadline", async () => {

		const silent: Endpoint = () => new Promise(() => {});
		expect(
			await causeOf(silent, { failoverAfterMs: 40, hedgeDelayMs: 10, throttle: createHedgeThrottle() })
		).toBe("no-first-chunk");
	});

	it("says rate-limited for a 429", async () => {
		const limited: Endpoint = async () => {
			throw Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
		};
		expect(await causeOf(limited)).toBe("rate-limited");
	});

	it("says empty-completion when the primary finished with no tokens", async () => {
		expect(await causeOf(laneYielding())).toBe("empty-completion");
	});

	it("names the HTTP status for any other HTTP error", async () => {
		const unavailable: Endpoint = async () => {
			throw Object.assign(new Error("503 Service Unavailable"), { status: 503 });
		};
		expect(await causeOf(unavailable)).toBe("http-503");
	});

	it("says error for a failure with no status", async () => {
		expect(await causeOf(laneThrowsBeforeFirst("socket hang up"))).toBe("error");
	});

	it("carries no cause when the primary was skipped, since nothing was attempted", async () => {
		const ep = withFailover([laneYielding("large3"), laneYielding("medium")], {
			laneModels: [LARGE3, MEDIUM],
		});
		for await (const v of await ep({ failPrimaryLane: true } as EndpointParameters)) {
			if (v.failover) expect(v.failover).toEqual({ from: LARGE3, to: MEDIUM, reason: "skipped" });
		}
	});
});

// CUR-2893. A 100,000-character paste refused by Mistral Medium's lane (needs ~63,633 tokens of
// 30,976) must not be answered by Mistral Small's 262,144-token lane: the visitor would see an answer
// from a model they had not picked instead of the refusal.
describe("CUR-2893: a message too long for the chosen model is refused, not retried or failed over", () => {
	const laneTooLong = (): Endpoint => async () => {
		throw new MessageTooLongError(63_633, 30_976);
	};

	it("surfaces the refusal after one call and never calls the backup or announces a switch", async () => {
		const primary = vi.fn(laneTooLong());
		const backup = vi.fn(laneYielding("small"));
		const ep = withFailover([primary, backup], { laneModels: ["mistral-medium-2604", "mistral-small-2603"] });
		const seen: unknown[] = [];
		await expect(
			(async () => {
				for await (const v of await ep(params)) seen.push(v);
			})()
		).rejects.toBeInstanceOf(MessageTooLongError);
		expect(seen).toEqual([]);
		expect(primary).toHaveBeenCalledOnce();
		expect(backup).not.toHaveBeenCalled();
	});

	it("does the same with hedging on and a failover deadline set", async () => {
		const primary = vi.fn(laneTooLong());
		const backup = vi.fn(laneYielding("small"));
		const ep = withFailover([primary, backup], {
			hedgeDelayMs: 50,
			throttle: createHedgeThrottle(),
			failoverAfterMs: 1_000,
		});
		await expect(collect(ep)).rejects.toBeInstanceOf(MessageTooLongError);
		expect(primary).toHaveBeenCalledOnce();
		expect(backup).not.toHaveBeenCalled();
	});
});

// CUR-2460. Medium-served answers must not introduce themselves as Mistral Large 3: the system
// prompt follows the lane that is picked, not the primary.
describe("a backup lane serving another model is told which model it is", () => {
	const LARGE = "mistral-large-2512";
	const MEDIUM = "mistral-medium-2604";
	const PERSONA_L = "You are Mistral Large 3, an open-weights model developed by Mistral AI.";
	const PERSONA_M = "You are Mistral Medium 3.5, an open-weights model developed by Mistral AI.";
	const FACTS_L = "You are Mistral Large 3, built by Mistral AI.";
	const FACTS_M = "You are Mistral Medium 3.5, built by Mistral AI.";
	// Catalog text that names Large 3 for a reason of its own; the swap must leave it alone.
	const CATALOG = "Known open-weight models include Mistral Large 3.";

	const turn = {
		preprompt: `${PERSONA_L}\n\n${CATALOG}`,
		messages: [{ from: "user", content: `${FACTS_L}\n\nQuel modèle es-tu ?` }],
		laneRewrites: { [MEDIUM]: [[PERSONA_L, PERSONA_M], [FACTS_L, FACTS_M]] },
	} as unknown as EndpointParameters;

	const recording = (seen: EndpointParameters[], text: string): Endpoint => async (p) => {
		seen.push(p);
		return (async function* () {
			yield chunk(text);
		})();
	};

	it("hands the backup the persona and facts written for its own model, and nothing else changed", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([laneThrowsOnInvoke("429"), recording(seen, "Je suis Medium")], {
			laneModels: [LARGE, MEDIUM],
		});
		for await (const _ of await ep(turn)) void _;
		expect(seen).toHaveLength(1);
		expect(seen[0].preprompt).toBe(`${PERSONA_M}\n\n${CATALOG}`);
		expect(seen[0].messages[0].content).toBe(`${FACTS_M}\n\nQuel modèle es-tu ?`);
	});

	it("sends the primary the request exactly as written", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([recording(seen, "Je suis Large"), laneYielding("unused")], {
			laneModels: [LARGE, MEDIUM],
		});
		for await (const _ of await ep(turn)) void _;
		expect(seen).toEqual([turn]);
	});

	it("rewrites nothing for a backup with no pairs of its own", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([laneThrowsOnInvoke("429"), recording(seen, "GLM")], {
			laneModels: [LARGE, "zai-org/GLM-5.3"],
		});
		for await (const _ of await ep(turn)) void _;
		expect(seen).toEqual([turn]);
	});
});

// `wrong_model_served` swaps the first lane's answer. The backup must answer clean, or a
// shed primary would hand the turn to a backup that sheds too, and the fault would prove nothing about
// the backup's honest label. (CUR-1614)
describe("CUR-1614: the wrong_model_served fault reaches the first lane only", () => {
	it("passes the substitute to lane 0 and leaves it off the backup lane's call", async () => {
		const seen: (string | undefined)[] = [];
		const recording =
			(fail: boolean): Endpoint =>
			async (p) => {
				seen.push(p.substituteServedModel);
				if (fail) throw new Error("model substitution exhausted retries");
				return (async function* () {
					yield chunk("glm");
				})();
			};
		const ep = withFailover([recording(true), recording(false)], {
			laneModels: ["swiss-ai/apertus-v1.5-70b", "zai-org/GLM-5.3"],
		});
		const gen = await ep({ substituteServedModel: "aisingapore/Qwen-SEA-LION-v4-32B-IT" } as EndpointParameters);
		for await (const _ of gen) void _;
		// Lane 0 may be called more than once (its own same-lane retry); the backup is called last.
		expect(seen.at(-1)).toBeUndefined();
		expect(seen.slice(0, -1).length).toBeGreaterThan(0);
		for (const s of seen.slice(0, -1)) expect(s).toBe("aisingapore/Qwen-SEA-LION-v4-32B-IT");
	});
});

// CUR-3939. A picked model is answered by itself or not at all (CUR-3936), so most models have one lane. A
// silent one ends the turn at its give-up rather than holding it until the route's 45s watchdog.
describe("CUR-3939: a silent last lane ends the turn at its give-up, not the watchdog", () => {
	const silent: Endpoint = () => new Promise(() => {});
	// A settling case passes the moment the give-up fires; the window only bounds a failure. It is wide
	// enough to hold on a loaded runner under coverage.
	const GIVE_UP_WINDOW_MS = 5_000;
	const settleWithin = async (ep: Endpoint, p: EndpointParameters, ms: number) => {
		const pull = (async () => {
			const gen = await ep(p);
			await gen.next();
			return "yielded";
		})().catch((e: unknown) => e);
		return Promise.race([pull, sleep(ms).then(() => "still waiting")]);
	};

	/** Reads the whole stream, so a failure after the first chunk comes back too. */
	const drainWithin = async (ep: Endpoint, p: EndpointParameters, ms: number) => {
		const pull = (async () => {
			for await (const _ of await ep(p)) void _;
			return "finished";
		})().catch((e: unknown) => e);
		return Promise.race([pull, sleep(ms).then(() => "still waiting")]);
	};

	it("rejects a single silent lane with no-first-chunk and a 504 once lastLaneGiveUpMs passes", async () => {
		const ep = withFailover([silent], { lastLaneGiveUpMs: 30 });
		const out = await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS);
		expect(out, "the silent lane held the turn past its give-up").toBeInstanceOf(NoFirstChunkError);
		expect((out as NoFirstChunkError).status).toBe(504);
	});

	it("gives up on a hedged silent lane too, after both same-lane attempts went quiet", async () => {
		const lane = vi.fn<Endpoint>(silent);
		const ep = withFailover([lane], {
			hedgeDelayMs: 10,
			lastLaneGiveUpMs: 60,
			throttle: createHedgeThrottle(),
		});
		expect(await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toBeInstanceOf(NoFirstChunkError);
		expect(lane, "the hedge never sent its second attempt before the give-up").toHaveBeenCalledTimes(2);
	});

	it("stalls the only lane under the primary_lane_hangs fault, so the preview scenario reaches the give-up", async () => {
		const ep = withFailover([laneYielding("apertus")], { lastLaneGiveUpMs: 30 });
		expect(
			await settleWithin(ep, { hangPrimaryLane: true } as EndpointParameters, GIVE_UP_WINDOW_MS)
		).toBeInstanceOf(NoFirstChunkError);
	});

	it("counts a silent last lane toward the model's busy mark, as a 429 does (CUR-4098)", async () => {
		busy.noteFailed.mockClear();
		const ep = withFailover([silent], { lastLaneGiveUpMs: 30, busyKey: "swiss-ai/apertus-v1.5-70b" });
		expect(await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toBeInstanceOf(NoFirstChunkError);
		await vi.waitFor(() => expect(busy.noteFailed).toHaveBeenCalledWith("swiss-ai/apertus-v1.5-70b"));
	});

	it("never counts a stall the primary_lane_hangs fault injected, since the mark is shared by the whole preview", async () => {
		busy.noteFailed.mockClear();
		const ep = withFailover([laneYielding("apertus")], {
			lastLaneGiveUpMs: 30,
			busyKey: "swiss-ai/apertus-v1.5-70b",
		});
		expect(
			await settleWithin(ep, { hangPrimaryLane: true } as EndpointParameters, GIVE_UP_WINDOW_MS)
		).toBeInstanceOf(NoFirstChunkError);
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("stalls every lane under the every_lane_hangs fault, so a backup cannot answer and the turn ends silent (CUR-4384)", async () => {
		busy.noteFailed.mockClear();
		const backup = vi.fn(laneYielding("apertus"));
		const ep = withFailover([laneYielding("apertus"), backup], {
			failoverAfterMs: 20,
			lastLaneGiveUpMs: 30,
			busyKey: "swiss-ai/apertus-v1.5-70b",
		});
		expect(
			await settleWithin(ep, { hangEveryLane: true } as EndpointParameters, GIVE_UP_WINDOW_MS)
		).toBeInstanceOf(NoFirstChunkError);
		expect(backup, "the backup lane was called, so its answer could reach the turn").not.toHaveBeenCalled();
		expect(busy.noteFailed, "an injected stall marked the model busy for the whole preview").not.toHaveBeenCalled();
	});

	it("counts a last lane the gateway ended with 504 toward the model's busy mark (CUR-4345)", async () => {
		busy.noteFailed.mockClear();
		const timedOut: Endpoint = async () => {
			throw Object.assign(new Error("504 Gateway Timeout"), { status: 504 });
		};
		const ep = withFailover([timedOut], { lastLaneGiveUpMs: 3_000, busyKey: "aisingapore/nemotron-sea-lion-v4.8-120b-a12b" });
		expect(await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toMatchObject({ status: 504 });
		await vi.waitFor(() =>
			expect(busy.noteFailed).toHaveBeenCalledWith("aisingapore/nemotron-sea-lion-v4.8-120b-a12b")
		);
	});

	it("does not count a last lane's 400 toward the busy mark: a refused request says nothing about whether the model is answering", async () => {
		busy.noteFailed.mockClear();
		const broken: Endpoint = async () => {
			throw Object.assign(new Error("400 Bad Request"), { status: 400 });
		};
		const ep = withFailover([broken], { lastLaneGiveUpMs: 3_000, busyKey: "aisingapore/nemotron-sea-lion-v4.8-120b-a12b" });
		expect(await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toMatchObject({ status: 400 });
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("counts a last lane's 404 or 5xx toward the model's busy mark: the router has no working entry for it (CUR-4629)", async () => {
		for (const status of [404, 500, 503]) {
			busy.noteFailed.mockClear();
			const down: Endpoint = async () => {
				throw Object.assign(new Error(`${status}`), { status });
			};
			const ep = withFailover([down], { lastLaneGiveUpMs: 3_000, busyKey: "mistralai/mistral-large-2610" });
			expect(await settleWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toMatchObject({ status });
			await vi.waitFor(() => expect(busy.noteFailed, String(status)).toHaveBeenCalledWith("mistralai/mistral-large-2610"));
		}
	});

	it("counts a later tool round's 404 before any answer text toward the busy mark, after round 1 answered (CUR-4629)", async () => {
		busy.noteFailed.mockClear();
		busy.noteAnswered.mockClear();
		const roundTwoNotFound: Endpoint = async () =>
			(async function* () {
				yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null } as TextGenerationStreamOutputSimplified;
				throw Object.assign(new Error("404 litellm.NotFoundError"), { status: 404 });
			})();
		const ep = withFailover([roundTwoNotFound], { lastLaneGiveUpMs: 3_000, busyKey: "mistralai/mistral-large-2610" });
		expect(await drainWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toMatchObject({ status: 404 });
		expect(busy.noteAnswered).toHaveBeenCalledWith("mistralai/mistral-large-2610");
		await vi.waitFor(() => expect(busy.noteFailed).toHaveBeenCalledWith("mistralai/mistral-large-2610"));
	});

	it("does not count a 404 that arrives after answer text streamed: the visitor got part of an answer", async () => {
		busy.noteFailed.mockClear();
		const midAnswer: Endpoint = async () =>
			(async function* () {
				yield chunk("Paris is");
				throw Object.assign(new Error("404"), { status: 404 });
			})();
		const ep = withFailover([midAnswer], { lastLaneGiveUpMs: 3_000, busyKey: "mistralai/mistral-large-2610" });
		expect(await drainWithin(ep, {} as EndpointParameters, GIVE_UP_WINDOW_MS)).toMatchObject({ status: 404 });
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("never counts a tool round a spec's fault refused, since the mark is shared by the whole preview", async () => {
		busy.noteFailed.mockClear();
		const faulted: Endpoint = async () =>
			(async function* () {
				yield { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null, details: null } as TextGenerationStreamOutputSimplified;
				throw Object.assign(new Error("429"), { status: 429 });
			})();
		const ep = withFailover([faulted], { lastLaneGiveUpMs: 3_000, busyKey: "mistralai/mistral-large-2610" });
		await drainWithin(ep, { rateLimitToolRoundSustained: true } as EndpointParameters, GIVE_UP_WINDOW_MS);
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("does not count a lane that answered inside its give-up toward the busy mark", async () => {
		busy.noteFailed.mockClear();
		const ep = withFailover([laneByCall({ delayMs: 10, text: "apertus" })], {
			lastLaneGiveUpMs: 200,
			busyKey: "swiss-ai/apertus-v1.5-70b",
		});
		expect(await collect(ep)).toEqual(["apertus"]);
		expect(busy.noteFailed).not.toHaveBeenCalled();
	});

	it("keeps a single lane that answers inside its give-up", async () => {
		const ep = withFailover([laneByCall({ delayMs: 10, text: "apertus" })], { lastLaneGiveUpMs: 200 });
		expect(await collect(ep)).toEqual(["apertus"]);
	});

	it("with no give-up set (flag off), still holds a single silent lane", async () => {
		const ep = withFailover([silent], { hedgeDelayMs: 10, throttle: createHedgeThrottle() });
		expect(await settleWithin(ep, {} as EndpointParameters, 150)).toBe("still waiting");
	});
});

describe("firstChunkTimings (CUR-3487)", () => {
	const on = { hedging: true, silentLaneFailover: true };

	it("keeps the fleet defaults (8s hedge, 12s failover) for a model with no allowance of its own", () => {
		expect(firstChunkTimings(null, on)).toEqual({
			hedgeDelayMs: 8_000,
			failoverAfterMs: 12_000,
			lastLaneGiveUpMs: null,
		});
	});

	it("neither hedges nor fails over before a slow-prefill model's own allowance", () => {
		expect(firstChunkTimings(20_000, on)).toEqual({
			hedgeDelayMs: 20_000,
			failoverAfterMs: 20_000,
			lastLaneGiveUpMs: null,
		});
	});

	it("gives a last-lane give-up only to a model that opted in, so a slow healthy model keeps the watchdog (CUR-3939)", () => {
		expect(firstChunkTimings(null, { ...on, giveUpMs: 20_000 }).lastLaneGiveUpMs).toBe(20_000);
		expect(firstChunkTimings(null, on).lastLaneGiveUpMs).toBeNull();
	});

	it("never hedges sooner than the fleet default, even for an allowance shorter than it", () => {
		expect(firstChunkTimings(5_000, on).hedgeDelayMs).toBe(8_000);
	});

	it("leaves each half off when its flag is off, whatever the allowance", () => {
		expect(
			firstChunkTimings(20_000, { hedging: false, silentLaneFailover: false, giveUpMs: 20_000 })
		).toEqual({
			hedgeDelayMs: null,
			failoverAfterMs: null,
			lastLaneGiveUpMs: null,
		});
	});
});

// CUR-2928. A router that names Large 3 `mistralai/mistral-large-2512` is asked for that id, but the
// answer is recorded under ours, and `tool-round-retry.spec.ts` reads the failover record's `from`.
describe("laneModelIds", () => {
	it("names each lane by our id when its host asks for the model under another name", () => {
		expect(
			laneModelIds("mistral-large-2512", [
				{ modelId: "mistralai/mistral-large-2512", servedAs: "mistral-large-2512" },
				{ modelId: "mistralai/mistral-medium-3-5", servedAs: "mistral-medium-2604" },
				{ modelId: "aisingapore/Gemma-SEA-LION-v4-27B-IT" },
				{},
			])
		).toEqual([
			"mistral-large-2512",
			"mistral-medium-2604",
			"aisingapore/Gemma-SEA-LION-v4-27B-IT",
			"mistral-large-2512",
		]);
	});
});

// A tool loop's later round goes out after the lane committed. When it stays over the host's
// cap through its retries before the answer has written a word, the next lane continues the same
// transcript, so the reader gets an answer and no tool runs twice. (CUR-2307)
describe("CUR-2307: a tool round still rate-limited before any answer text continues on the next lane", () => {
	const LARGE = "mistral-large-2512";
	const MEDIUM = "mistral-medium-2604";
	const rateLimited = () => Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });
	const transcript = [
		{ role: "system", content: "You are Mistral Large 3." },
		{ role: "user", content: "3 x 14 x 18?" },
		{ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "calculate", arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "c1", content: "756" },
	] as ToolRoundHandoff["messages"];
	const special = { token: { id: -1, text: "", logprob: 0, special: true }, generated_text: null } as unknown as TextGenerationStreamOutputSimplified;

	// A primary whose loop shows a tool frame, then hands off (or, with `text`, writes some answer first).
	const primaryHandsOff = (text?: string): Endpoint => async () =>
		(async function* () {
			yield special;
			if (text) yield chunk(text);
			throw new ToolRoundHandoff(rateLimited(), transcript, 1);
		})();

	const recording = (seen: EndpointParameters[], text: string): Endpoint => async (p) => {
		seen.push(p);
		return (async function* () {
			yield chunk(text);
		})();
	};

	it("hands the backup the transcript and round, announced as a rate-limited failover, and the turn answers", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([primaryHandsOff(), recording(seen, "756 euros")], { laneModels: [LARGE, MEDIUM] });
		const out: TextGenerationStreamOutputSimplified[] = [];
		for await (const v of await ep(params)) out.push(v);
		expect(out.map((v) => v.token.text).join("")).toBe("756 euros");
		expect(out.find((v) => v.failover)?.failover).toEqual({ from: LARGE, to: MEDIUM, reason: "unavailable", cause: "rate-limited" });
		expect(seen).toHaveLength(1);
		expect(seen[0].toolTranscript).toEqual({ messages: transcript, round: 1 });
	});

	it("renames the model in the handed-over transcript with the backup's own rewrite pairs", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([primaryHandsOff(), recording(seen, "ok")], { laneModels: [LARGE, MEDIUM] });
		const p = { messages: [], laneRewrites: { [MEDIUM]: [["You are Mistral Large 3.", "You are Mistral Medium 3.5."]] } } as unknown as EndpointParameters;
		for await (const _ of await ep(p)) void _;
		expect(seen[0].toolTranscript?.messages[0].content).toBe("You are Mistral Medium 3.5.");
		expect(seen[0].toolTranscript?.messages.slice(1)).toEqual(transcript.slice(1));
	});

	it("ends on the 429 itself, not a handoff, once answer text has reached the reader (no splice)", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([primaryHandsOff("The total is"), recording(seen, "unused")], { laneModels: [LARGE, MEDIUM] });
		const err = await collect(ep).catch((e: unknown) => e);
		expect((err as { status?: number }).status).toBe(429);
		expect(err).not.toBeInstanceOf(ToolRoundHandoff);
		expect(seen).toHaveLength(0);
	});

	it("ends on the 429 itself when the lane that handed off was the last one", async () => {
		const ep = withFailover([primaryHandsOff()], { laneModels: [LARGE], hedgeDelayMs: 60_000 });
		const err = await collect(ep).catch((e: unknown) => e);
		expect((err as { status?: number }).status).toBe(429);
		expect(err).not.toBeInstanceOf(ToolRoundHandoff);
	});

	it("keeps the sustained tool-round fault off the backup lane", async () => {
		const seen: EndpointParameters[] = [];
		const ep = withFailover([primaryHandsOff(), recording(seen, "ok")], { laneModels: [LARGE, MEDIUM] });
		for await (const _ of await ep({ rateLimitToolRoundSustained: true } as EndpointParameters)) void _;
		expect(seen[0].rateLimitToolRoundSustained).toBeUndefined();
	});
});

describe("a turn's abort reason reaches the lane through the failover wrapper", () => {
	// The agent endpoint tells the route's watchdog from a person's Stop by the abort REASON
	// (endedByWatchdog). The wrapper chains the turn's signal into a controller per attempt; a bare
	// abort() there would erase the reason, and every watchdog-ended agent turn would read as "stopped".
	/** A lane that records the reason its signal aborted with, then ends like a real fetch would. */
	const laneRecordingReason = (seen: unknown[]): Endpoint => async (p) =>
		(async function* () {
			yield chunk("first");
			await new Promise<void>((resolve) => {
				if (p.abortSignal?.aborted) resolve();
				else p.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
			seen.push(p.abortSignal?.reason);
			throw new DOMException("aborted", "AbortError");
		})();

	async function reasonSeenThrough(opts: Parameters<typeof withFailover>[1]) {
		const seen: unknown[] = [];
		const turn = new AbortController();
		const ep = withFailover([laneRecordingReason(seen)], opts);
		const gen = await ep({ ...params, abortSignal: turn.signal });
		await gen.next();
		const why = new Error("watchdog");
		turn.abort(why);
		await expect(gen.next()).rejects.toThrow();
		return { seen, why };
	}

	it("the hedged race forwards the turn's reason, not a bare abort", async () => {
		const { seen, why } = await reasonSeenThrough({ hedgeDelayMs: 1_000, throttle: createHedgeThrottle() });
		expect(seen).toEqual([why]);
	});

	it("a lane with a first-chunk give-up forwards the turn's reason, not a bare abort", async () => {
		const { seen, why } = await reasonSeenThrough({ lastLaneGiveUpMs: 1_000 });
		expect(seen).toEqual([why]);
	});
});

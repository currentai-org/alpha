import { describe, expect, it, vi } from "vitest";
import { classifyFailureLayer } from "$lib/chat/utils/failureLayer";
import type { TurnOutcome } from "$lib/chat/utils/outcomeLadder";
import { FIRE_THRESHOLD } from "./alerting";
import { failureCauseOfError } from "./textGeneration/failureCause";
import {
	BURN_RULES,
	OURS_SLO,
	WINDOW_MS,
	burnVerdicts,
	isOursFailure,
	probeHealth,
	ruleVerdict,
	upstreamModelsOver,
	windowsFor,
	type OutcomeAgg,
	type WindowKey,
	type Windows,
} from "./turnBurnRate";

// alerting.ts is imported for its fire threshold only; nothing here touches the database.
vi.mock("$lib/chat/server/db/client", () => ({ getDb: () => ({}) }));

const fast = BURN_RULES[0];
const w = (total: number, bad: number) => ({ total, bad });
const windows = (short: [number, number], long: [number, number]): Windows => ({
	"5m": w(...short),
	"30m": w(...short),
	"1h": w(...long),
	"6h": w(...long),
});

describe("ruleVerdict, multi-window burn rate", () => {
	it("is over only when BOTH the long and the short window burn above the rule's rate", () => {
		expect(ruleVerdict(windows([5, 3], [30, 6]), OURS_SLO, fast).kind).toBe("over");
		expect(ruleVerdict(windows([5, 0], [30, 6]), OURS_SLO, fast).kind).toBe("ok");
	});

	it("gives no verdict on 1 failed turn of 2, so a blip never pages", () => {
		expect(ruleVerdict(windows([2, 1], [2, 1]), OURS_SLO, fast).kind).toBe("no-verdict");
	});

	it("is healthy with fewer than 3 failures in the long window, whatever the rate", () => {
		expect(ruleVerdict(windows([10, 2], [10, 2]), OURS_SLO, fast).kind).toBe("ok");
	});

	it("holds when the long window is over and the short window saw no turn at all: silence is not recovery", () => {
		expect(ruleVerdict(windows([0, 0], [30, 6]), OURS_SLO, fast).kind).toBe("hold");
	});
});

describe("upstreamModelsOver", () => {
	const row = (model: string, outcome: string, layer: string | null, n: number): OutcomeAgg => ({
		outcome,
		failureLayer: layer,
		model,
		counts: { "5m": n, "30m": n, "1h": n, "6h": n },
	});

	it("names a partner model failing 3 of its 3 turns while the busy site around it is healthy", () => {
		const v = upstreamModelsOver([
			row("mistral-large-2512", "complete", null, 40),
			row("BSC-LT/ALIA-40b-instruct", "timedOut", "upstream", 3),
		]);
		expect(v).toEqual({ over: ["BSC-LT/ALIA-40b-instruct"], health: false });
	});

	it("does not name a model for its 2 failures — still under the per-model floor", () => {
		const v = upstreamModelsOver([row("BSC-LT/ALIA-40b-instruct", "timedOut", "upstream", 2)]);
		expect(v.over).toEqual([]);
	});

	it("does not count our own failures against a model's host", () => {
		const v = upstreamModelsOver([row("mistral-large-2512", "error", "ours", 5)]);
		expect(v.over).toEqual([]);
	});
});

// The paging contract, end to end: the error the model call threw, through the route's own classifiers
// (failureCauseOfError, classifyFailureLayer), into the warm cron's per-minute aggregate and the fast
// rule, and through recordProbe's debounce (FIRE_THRESHOLD consecutive unhealthy reads post to Slack).
describe("turn:outcome-rate pages on our pipeline, not on a partner host", () => {
	const T0 = Date.parse("2026-11-03T15:00:00Z");
	const MIN = 60_000;
	type Turn = { t: number; outcome: TurnOutcome; layer: string | null; model: string };

	/** A thrown upstream error shaped like the OpenAI SDK's APIError: a status and the host's text. */
	const httpError = (status: number) => Object.assign(new Error(`${status} status code`), { status });

	/** ~8 completed turns an hour on Large 3 for the six hours before the burst and through it. */
	function background(until: number): Turn[] {
		const out: Turn[] = [];
		for (let t = T0; t <= until; t += 7.5 * MIN)
			out.push({ t, outcome: "complete", layer: null, model: "mistral-large-2512" });
		return out;
	}

	/** Failed GLM turns at the minutes a production burst logged them, each classified the way the route does. */
	function burst(status: number): Turn[] {
		const at = ["21:16", "21:20", "21:31", "21:38", "21:46", "21:50"];
		return at.map((hm) => {
			const outcome: TurnOutcome = "error";
			const layer = classifyFailureLayer({
				outcome,
				cause: failureCauseOfError(httpError(status)),
				isLocalModel: false,
				firstTokenReached: false,
			});
			return { t: Date.parse(`2026-11-03T${hm}:00Z`), outcome, layer, model: "zai-org/GLM-5.2" };
		});
	}

	/** countTurnOutcomeWindows at `now`, from an in-memory list instead of the table. */
	function aggAt(turns: readonly Turn[], now: number): OutcomeAgg[] {
		const m = new Map<string, OutcomeAgg>();
		for (const x of turns) {
			if (x.t > now || x.t <= now - WINDOW_MS["6h"]) continue;
			const k = `${x.outcome}|${x.layer}|${x.model}`;
			const r = m.get(k) ?? {
				outcome: x.outcome,
				failureLayer: x.layer,
				model: x.model,
				counts: { "5m": 0, "30m": 0, "1h": 0, "6h": 0 },
			};
			for (const w of Object.keys(WINDOW_MS) as WindowKey[]) if (x.t > now - WINDOW_MS[w]) r.counts[w]++;
			m.set(k, r);
		}
		return [...m.values()];
	}

	/** Whether the fast rule, read every minute from 21:00 to 22:30, reached FIRE_THRESHOLD consecutive
	 *  unhealthy reads (a null read records nothing, as recordBurnProbe does). */
	function pages(turns: readonly Turn[]): boolean {
		let unhealthy = 0;
		for (let now = Date.parse("2026-11-03T21:00:00Z"); now <= Date.parse("2026-11-03T22:30:00Z"); now += MIN) {
			const healthy = probeHealth([burnVerdicts(windowsFor(aggAt(turns, now), isOursFailure), OURS_SLO).fast]);
			if (healthy === null) continue;
			unhealthy = healthy ? 0 : unhealthy + 1;
			if (unhealthy >= FIRE_THRESHOLD) return true;
		}
		return false;
	}

	const end = Date.parse("2026-11-03T22:30:00Z");

	it("MUST page on six of our own HTTP 402 failures in 35 minutes at ~8 turns an hour (a production burst on one model)", () => {
		const glm402 = burst(402);
		expect(glm402.every((x) => x.layer === "ours")).toBe(true);
		expect(pages([...background(end), ...glm402])).toBe(true);
	});

	it("MUST NOT page on the same burst as HTTP 429s from a partner host: those are the host's, on turn:upstream-rate", () => {
		const glm429 = burst(429);
		expect(glm429.every((x) => x.layer === "upstream")).toBe(true);
		const turns = [...background(end), ...glm429];
		expect(pages(turns)).toBe(false);
		expect(upstreamModelsOver(aggAt(turns, Date.parse("2026-11-03T21:50:00Z"))).over).toEqual(["zai-org/GLM-5.2"]);
	});
});

import { afterEach, describe, expect, it } from "vitest";
import {
	ANSWER_ROUND_MARGIN_MS,
	FALLBACK_TOKENS_PER_SECOND,
	MIN_ANSWER_SAMPLES,
	TurnPace,
	expectedAnswerRoundMs,
	forgetAnswerRounds,
	lastToolRoundAt,
	observeRound,
	recordAnswerRound,
	typicalAnswerTokens,
} from "./answerRoundBudget";

afterEach(() => forgetAnswerRounds());

describe("the tool loop's deadline check", () => {
	it("stops offering tools once the answer round would no longer end before the ceiling", () => {
		const ceilingAt = 205_000;
		// 6,000 tokens at 50 tok/s is 120 s; with the 10 s margin the last tool round may start at 75 s.
		const expectedAnswerMs = expectedAnswerRoundMs({ answerTokens: 6_000, tokensPerSecond: 50, firstChunkMs: 0 });
		expect(expectedAnswerMs).toBe(120_000);
		expect(lastToolRoundAt({ ceilingAt, expectedAnswerMs })).toBe(205_000 - 120_000 - ANSWER_ROUND_MARGIN_MS);
	});

	it("a slower measured pace stops tools earlier for the same answer length", () => {
		const fast = expectedAnswerRoundMs({ answerTokens: 4_096, tokensPerSecond: 120, firstChunkMs: 0 });
		const slow = expectedAnswerRoundMs({ answerTokens: 4_096, tokensPerSecond: 40, firstChunkMs: 0 });
		expect(lastToolRoundAt({ ceilingAt: 155_000, expectedAnswerMs: slow })).toBeLessThan(
			lastToolRoundAt({ ceilingAt: 155_000, expectedAnswerMs: fast })
		);
	});

	it("counts the measured first-chunk wait into the answer round", () => {
		expect(expectedAnswerRoundMs({ answerTokens: 1_000, tokensPerSecond: 100, firstChunkMs: 3_000 })).toBe(13_000);
	});

	it("assumes the conservative fallback rate when the turn has measured none, never an unbounded one", () => {
		expect(expectedAnswerRoundMs({ answerTokens: 4_000, tokensPerSecond: undefined, firstChunkMs: 0 })).toBe(
			(4_000 / FALLBACK_TOKENS_PER_SECOND) * 1000
		);
		expect(expectedAnswerRoundMs({ answerTokens: 4_000, tokensPerSecond: 0, firstChunkMs: 0 })).toBe(
			(4_000 / FALLBACK_TOKENS_PER_SECOND) * 1000
		);
	});
});

describe("the turn's measured pace", () => {
	it("is tokens over streaming time across the rounds long enough to time", () => {
		const pace = new TurnPace();
		expect(pace.tokensPerSecond()).toBeUndefined();
		pace.observe({ completionTokens: 300, streamMs: 6_000, firstChunkMs: 1_200 });
		pace.observe({ completionTokens: 200, streamMs: 4_000, firstChunkMs: 2_500 });
		expect(pace.tokensPerSecond()).toBe(50);
		expect(pace.firstChunkMs()).toBe(2_500);
	});

	it("leaves out a round too short to time, so one tool call's few tokens can't claim a fast lane", () => {
		const pace = new TurnPace();
		pace.observe({ completionTokens: 20, streamMs: 10, firstChunkMs: 900 });
		expect(pace.tokensPerSecond()).toBeUndefined();
	});
});

describe("a model's typical answer length", () => {
	it("is the fallback until enough answer rounds are recorded, then their median", () => {
		expect(typicalAnswerTokens("model-a", 4_096)).toEqual({ tokens: 4_096, source: "fallback" });
		for (const n of [5_000, 9_000, 6_000].slice(0, MIN_ANSWER_SAMPLES)) recordAnswerRound("model-a", n);
		expect(typicalAnswerTokens("model-a", 4_096)).toEqual({ tokens: 6_000, source: "measured" });
		expect(typicalAnswerTokens("model-b", 4_096).source).toBe("fallback");
	});
});

describe("observing a round", () => {
	async function* rounds(outputs: object[]) {
		for (const o of outputs) yield o;
	}

	it("passes every output through and reports the provider's token count and whether tools were called", async () => {
		let t = 1_000;
		const now = () => (t += 500);
		const outputs = [
			{ token: { text: "abc" } },
			{ token: { text: "" }, toolCalls: [{ id: "1" }] },
			{ token: { text: "" }, usage: { completionTokens: 321 } },
		];
		const seen: object[] = [];
		let report: { sample: unknown; calledTools: boolean } | undefined;
		for await (const out of observeRound(rounds(outputs), {
			sentAt: 0,
			now,
			onDone: (sample, calledTools) => (report = { sample, calledTools }),
		}))
			seen.push(out);
		expect(seen).toEqual(outputs);
		expect(report).toEqual({
			sample: { completionTokens: 321, streamMs: 500, firstChunkMs: 1_500 },
			calledTools: true,
		});
	});

	it("estimates tokens from streamed characters when the round reports no usage", async () => {
		let report: { completionTokens: number } | undefined;
		const gen = observeRound(rounds([{ token: { text: "x".repeat(4_400) } }]), {
			sentAt: 0,
			onDone: (sample) => (report = sample),
		});
		for await (const _ of gen) void _;
		expect(report?.completionTokens).toBe(1_000);
	});
});

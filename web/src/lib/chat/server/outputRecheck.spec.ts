import { describe, it, expect, vi } from "vitest";
import { recheckOutputBlock, recheckFault, recheckFaultFlag } from "./outputRecheck";
import { screenOutputWithGuard } from "./guardGate";
import { makeShieldstralJudge } from "./detectors/shieldstral";
import { GUARD_WINDOW_CHARS, loadGuardPolicy } from "./guardPolicy";
import type { GuardHit, JudgeFn, JudgeOutcome, JudgeTarget } from "./guardScreenTypes";
import type { OutputScreenResult } from "./moderation";

const policy = loadGuardPolicy();
if (!policy) throw new Error("rules.json failed to load");
const keyOf = (query: string) => policy.entries.find((r) => r.query === query)?.key;

const hit = (key: string, tier: GuardHit["tier"] = "content", action: GuardHit["action"] = "block"): GuardHit => ({
	key,
	action,
	tier,
});
const flagged = (category: string, hits: GuardHit[]): OutputScreenResult => ({
	blocked: true,
	kind: "content_policy",
	category,
	hits,
});
const toxic = flagged("chat-block-toxic", [hit("chat-block-toxic")]);

const no: JudgeOutcome = { answer: { kind: "score", score: 0.01, yes: false }, httpOk: true, servedModel: "m" };
const yes: JudgeOutcome = { answer: { kind: "score", score: 0.97, yes: true }, httpOk: true, servedModel: "m" };
const unknown: JudgeOutcome = { answer: { kind: "unknown" }, httpOk: false };

/** A judge that answers per rule key, and records what it was asked. */
function judgeBy(answers: Record<string, JudgeOutcome>) {
	const asked: Array<{ key: string | undefined; text: string }> = [];
	const judge: JudgeFn = async (target: JudgeTarget, query: string) => {
		const key = keyOf(query);
		asked.push({ key, text: target.kind === "text" ? target.text : "" });
		return answers[key ?? ""] ?? no;
	};
	return { judge, asked };
}
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("recheckOutputBlock — lifts a block only on a clear no", () => {
	it("releases a flagged content batch when every block rule that fired answers no, keeping the hits for review", async () => {
		const { judge } = judgeBy({});
		const res = await recheckOutputBlock("Some answer. ", "The flagged batch.", toxic, { judge, logger: quiet });
		expect(res).toEqual({ blocked: false, kind: null, hits: toxic.hits });
	});

	it("keeps the block when any one of several fired rules still answers yes", async () => {
		const first = flagged("chat-block-toxic", [hit("chat-block-toxic"), hit("chat-block-hate")]);
		const { judge } = judgeBy({ "chat-block-hate": yes });
		expect(await recheckOutputBlock("answer ", "batch", first, { judge, logger: quiet })).toBe(first);
	});

	it("keeps the block (fails closed) when the re-check cannot answer", async () => {
		const { judge } = judgeBy({ "chat-block-toxic": unknown });
		expect(await recheckOutputBlock("answer ", "batch", toxic, { judge, logger: quiet })).toBe(toxic);
	});

	it("keeps the block (fails closed) when the re-check outlasts its bound", async () => {
		const judge: JudgeFn = () => new Promise(() => {});
		expect(await recheckOutputBlock("answer ", "batch", toxic, { judge, logger: quiet, timeoutMs: 20 })).toBe(toxic);
	});

	it("keeps the block when the judge throws", async () => {
		const judge: JudgeFn = async () => {
			throw new Error("boom");
		};
		expect(await recheckOutputBlock("answer ", "batch", toxic, { judge, logger: quiet })).toBe(toxic);
	});

	it("passes the judge whole milliseconds when its budget is fractional", async () => {
		const timeouts: number[] = [];
		const judge: JudgeFn = async (_t, _q, _th, ctx) => {
			timeouts.push(ctx.timeoutMs);
			return no;
		};
		const res = await recheckOutputBlock("answer ", "batch", toxic, { judge, logger: quiet, timeoutMs: 4999.75 });
		expect(res.blocked).toBe(false);
		expect(timeouts).toEqual([4999]);
	});

	it("keeps the block, asking nothing, when less than a whole millisecond of budget is left", async () => {
		const { judge, asked } = judgeBy({});
		expect(await recheckOutputBlock("answer ", "batch", toxic, { judge, logger: quiet, timeoutMs: 0.5 })).toBe(toxic);
		expect(asked).toHaveLength(0);
	});

	it("cancels its judge calls at its bound, so none runs on or starts after it", async () => {
		const nine = [
			"chat-block-toxic",
			"chat-block-hate",
			"chat-block-harrasment",
			"chat-block-violence",
			"chat-block-drugs",
			"chat-block-fraud",
			"chat-block-anthro",
			"chat-block-privacy",
			"chat-block-sexual",
		];
		const first = flagged("chat-block-toxic", nine.map((k) => hit(k)));
		const signals: AbortSignal[] = [];
		const judge: JudgeFn = (_t, _q, _th, ctx) => {
			if (ctx.opSignal.aborted) return Promise.resolve(unknown);
			signals.push(ctx.opSignal);
			return new Promise((resolve) => ctx.opSignal.addEventListener("abort", () => resolve(unknown), { once: true }));
		};
		expect(await recheckOutputBlock("answer ", "batch", first, { judge, logger: quiet, timeoutMs: 30 })).toBe(first);
		await new Promise((r) => setTimeout(r, 40));
		expect(signals.length).toBeLessThan(nine.length);
		expect(signals.every((sig) => sig.aborted)).toBe(true);
	});

	it("keeps the block on a bare \"no\" without logprobs, since only a score under the threshold lifts it", async () => {
		const reply = (body: unknown) =>
			new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		const bareNo = makeShieldstralJudge({
			endpoint: "http://shield.test/v1/chat/completions",
			token: "t",
			fetchImpl: (async () =>
				reply({ model: "mistralai/Shieldstral-1.0-3B", choices: [{ message: { content: "no" } }] })) as typeof fetch,
		});
		expect(await recheckOutputBlock("answer ", "batch", toxic, { judge: bareNo, logger: quiet })).toBe(toxic);
		const scoredNo = makeShieldstralJudge({
			endpoint: "http://shield.test/v1/chat/completions",
			token: "t",
			fetchImpl: (async () =>
				reply({
					model: "mistralai/Shieldstral-1.0-3B",
					choices: [
						{
							message: { content: "no" },
							logprobs: { content: [{ top_logprobs: [{ token: "no", logprob: -0.01 }, { token: "yes", logprob: -5 }] }] },
						},
					],
				})) as typeof fetch,
		});
		expect((await recheckOutputBlock("answer ", "batch", toxic, { judge: scoredNo, logger: quiet })).blocked).toBe(false);
	});

	it("keeps the block when a fired rule is one the output screen never asks, since no rule answered", async () => {
		const inputOnly = policy.entries.map((r) => (r.key === "chat-block-toxic" ? { ...r, screens: ["input" as const] } : r));
		const { judge, asked } = judgeBy({});
		const res = await recheckOutputBlock("answer ", "batch", toxic, {
			judge,
			logger: quiet,
			policy: { ...policy, entries: inputOnly, byKey: new Map(inputOnly.map((e) => [e.key, e])) },
		});
		expect(asked).toHaveLength(0);
		expect(res).toBe(toxic);
	});

	it("keeps the block when a fired rule is no longer in the policy", async () => {
		const first = flagged("chat-block-retired", [hit("chat-block-retired")]);
		const { judge, asked } = judgeBy({});
		expect(await recheckOutputBlock("answer ", "batch", first, { judge, logger: quiet })).toBe(first);
		expect(asked).toHaveLength(0);
	});
});

describe("recheckOutputBlock — what it never re-checks", () => {
	const never: Array<[string, OutputScreenResult]> = [
		["a child-safety hit", { blocked: true, kind: "child_safety", category: "chat-block-child-grooming", hits: [hit("chat-block-child-grooming", "child")] }],
		["a check that could not finish", { blocked: true, kind: "child_safety", unscreened: true, hits: [] }],
		["a self-harm hit, whose decline is crisis support", flagged("chat-block-self-harm", [hit("chat-block-self-harm")])],
		["a content block that co-fired with a child rule", flagged("chat-block-toxic", [hit("chat-block-toxic"), hit("chat-block-child-grooming", "child")])],
		["a content block that co-fired with self-harm", flagged("chat-block-toxic", [hit("chat-block-toxic"), hit("chat-block-self-harm-passive")])],
		["a block whose rule is not among its hits (the test override)", flagged("cur-1139-test-override", [])],
		["a block with only log hits", flagged("chat-block-toxic", [hit("chat-block-toxic", "content", "log")])],
		["a content block beside a child query that went unanswered", { ...toxic, childUnknown: true }],
		["a released batch", { blocked: false, kind: null }],
	];
	it.each(never)("never asks the judge about %s, and returns the first verdict unchanged", async (_name, first) => {
		const { judge, asked } = judgeBy({});
		expect(await recheckOutputBlock("answer ", "batch", first, { judge, logger: quiet })).toBe(first);
		expect(asked).toHaveLength(0);
	});
});

describe("recheckOutputBlock — what the judge reads", () => {
	it("asks only the block rules that fired, about the question and the whole answer so far", async () => {
		const first = flagged("chat-block-toxic", [hit("chat-block-toxic"), hit("chat-block-hate"), hit("chat-block-drugs", "content", "log")]);
		const { judge, asked } = judgeBy({});
		await recheckOutputBlock("Opening paragraph. ", "The flagged batch.", first, {
			judge,
			logger: quiet,
			askerText: "Explain my essay to a five-year-old",
		});
		expect(asked.map((a) => a.key).sort()).toEqual(["chat-block-hate", "chat-block-toxic"]);
		for (const a of asked) {
			expect(a.text).toBe(
				"The person asked:\nExplain my essay to a five-year-old\n\nThe assistant's answer:\nOpening paragraph. The flagged batch."
			);
		}
	});

	it("keeps the whole flagged batch inside the judge's window when the answer is longer than the window", async () => {
		const batch = "THE FLAGGED BATCH. " + "b".repeat(5000);
		const { judge, asked } = judgeBy({});
		await recheckOutputBlock("x".repeat(GUARD_WINDOW_CHARS * 2), batch, toxic, {
			judge,
			logger: quiet,
			askerText: "q".repeat(5000),
		});
		const text = asked[0].text;
		expect(text.length).toBeLessThanOrEqual(GUARD_WINDOW_CHARS);
		expect(text.endsWith(batch)).toBe(true);
	});

	it("keeps the block, asking nothing, when the flagged batch alone is too long for the judge to read whole", async () => {
		const { judge, asked } = judgeBy({});
		const batch = "FLAGGED " + "benign ".repeat(1800) + ". ";
		expect(await recheckOutputBlock("", batch, toxic, { judge, logger: quiet })).toBe(toxic);
		expect(asked).toHaveLength(0);
	});

	it("judges the answer alone when there is no question", async () => {
		const { judge, asked } = judgeBy({});
		await recheckOutputBlock("Just ", "the answer.", toxic, { judge, logger: quiet });
		expect(asked[0].text).toBe("Just the answer.");
	});
});

describe("screenOutputWithGuard → recheckOutputBlock", () => {
	it("never lifts a content block whose screen left a child query unanswered", async () => {
		const childKeys = new Set(policy.entries.filter((r) => r.tier === "child").map((r) => r.key));
		const asked: string[] = [];
		const judge: JudgeFn = async (_t, query) => {
			const key = keyOf(query) ?? "";
			asked.push(key);
			if (childKeys.has(key)) return unknown;
			return key === "chat-block-toxic" ? yes : no;
		};
		const first = await screenOutputWithGuard("a batch", undefined, { judge, logger: quiet });
		expect(first).toMatchObject({ blocked: true, kind: "content_policy", category: "chat-block-toxic", childUnknown: true });
		asked.length = 0;
		expect(await recheckOutputBlock("answer ", "a batch", first, { judge: async () => no, logger: quiet })).toBe(first);
	});
});

describe("the output_screen_recheck_clears fault", () => {
	it("puts no hit on the ledger, whether the re-check clears, is skipped or keeps the block", async () => {
		expect(recheckFaultFlag().hits).toEqual([]);
		const cleared = await recheckFault("answer ", "batch", recheckFaultFlag());
		expect(cleared).toEqual({ blocked: false, kind: null, hits: [] });
		const tooLong = await recheckFault("", "x".repeat(GUARD_WINDOW_CHARS), recheckFaultFlag());
		expect(tooLong).toEqual(recheckFaultFlag());
	});
});

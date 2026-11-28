// The self-host Shieldstral-only screen (SAFETY_SCREEN=shieldstral) asks one question per first-pass group before that group's rules,
// so a benign turn on the safety profile's CPU makes fewer classifier calls than it has
// rules. Verdicts must not move: a group that says yes or gives no answer has all its rules asked, and
// child rules and ungrouped rules are asked regardless. A hosted edition keeps one call per rule.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { JudgeFn, JudgeOutcome } from "./guardScreenTypes";
import { SELFHOST_FIRST_PASSES } from "../../../../config/selfhostScreen.mjs";

vi.mock("$lib/chat/server/db/guardDailyCounts", () => ({ countGuardHitsSafe: vi.fn() }));

const input = (corpus: string) => ({ corpus, typedTurnText: corpus, images: [], failedUnits: [] });
const answer = (yes: boolean | "unknown"): JudgeOutcome => ({
	answer: yes === "unknown" ? { kind: "unknown" } : { kind: "score", score: yes ? 0.9 : 0.01, yes },
	httpOk: true,
	servedModel: "mistralai/Shieldstral-1.0-3B",
});

const groupByQuery = new Map(SELFHOST_FIRST_PASSES.map((g) => [g.query, g.name]));
const grouped = new Set(SELFHOST_FIRST_PASSES.flatMap((g) => g.rules));

/** A judge that answers every first-pass group with `firstPass` and every rule query no, except the
 *  rule keys listed in `fires`, and records which queries it was asked (a group by its name). */
async function judgeWith(firstPass: boolean | "unknown", fires: string[] = []) {
	const { loadGuardPolicy } = await import("./guardPolicy");
	const byQuery = new Map(loadGuardPolicy()!.entries.map((r) => [r.query, r.key]));
	const asked: string[] = [];
	const judge = vi.fn<JudgeFn>(async (_target, query) => {
		const group = groupByQuery.get(query);
		if (group) {
			asked.push(group);
			return answer(firstPass);
		}
		const key = byQuery.get(query) ?? "?";
		asked.push(key);
		return answer(fires.includes(key));
	});
	return { judge, asked };
}

async function screenAs(edition: "selfhost" | "hosted", judge: JudgeFn, safetyScreen = "shieldstral") {
	vi.stubEnv("ALPHA_EDITION", edition);
	vi.stubEnv("SAFETY_SCREEN", safetyScreen);
	const { runGuardScreen, rulesForScreen } = await import("./guardGate");
	const { loadGuardPolicy } = await import("./guardPolicy");
	const rules = rulesForScreen(loadGuardPolicy()!.entries, {});
	const result = await runGuardScreen(input("What is the capital of France?"), { judge, logger: { info() {}, warn() {}, error() {} } as never });
	return { result, rules };
}

afterEach(() => vi.unstubAllEnvs());

describe("the self-host screen's first pass makes fewer calls without changing a verdict", () => {
	it("a benign self-host turn asks each group once instead of its rules, fewer calls than it has rules", async () => {
		const { judge, asked } = await judgeWith(false);
		const { result, rules } = await screenAs("selfhost", judge);
		const direct = rules.filter((r) => r.tier === "child" || !grouped.has(r.key)).map((r) => r.key);
		expect(asked.sort()).toEqual([...direct, ...SELFHOST_FIRST_PASSES.map((g) => g.name)].sort());
		expect(asked.length).toBeLessThan(rules.length);
		expect(result.status).toBe("safe");
	});

	it("a group that says yes has its rules asked, and the one that fires blocks", async () => {
		const { judge, asked } = await judgeWith(true, ["chat-block-hate"]);
		const { result, rules } = await screenAs("selfhost", judge);
		expect(asked).toHaveLength(rules.length + SELFHOST_FIRST_PASSES.length);
		expect(result.status).toBe("unsafe");
		expect(result.blockHits.map((r) => r.key)).toEqual(["chat-block-hate"]);
	});

	it("a group with no answer has its rules asked rather than passing the turn", async () => {
		const { judge, asked } = await judgeWith("unknown");
		const { result, rules } = await screenAs("selfhost", judge);
		expect(asked).toHaveLength(rules.length + SELFHOST_FIRST_PASSES.length);
		// Every rule answered no, so the unanswered groups leave the screen safe.
		expect(result.status).toBe("safe");
	});

	it("an ungrouped rule is asked and blocks when every group says no", async () => {
		const { judge } = await judgeWith(false, ["chat-block-violence"]);
		const { result } = await screenAs("selfhost", judge);
		expect(result.blockHits.map((r) => r.key)).toEqual(["chat-block-violence"]);
	});

	it("a child rule still blocks when the first pass says no", async () => {
		const { judge } = await judgeWith(false, ["chat-block-child-grooming"]);
		const { result } = await screenAs("selfhost", judge);
		expect(result.blockHits.map((r) => r.key)).toEqual(["chat-block-child-grooming"]);
		expect(result.status).toBe("unsafe");
	});

	it("the self-host screen never has more calls in flight than the classifier has slots", async () => {
		const { SELFHOST_CLASSIFIER_SLOTS } = await import("../../../../config/selfhostScreen.mjs");
		let inFlight = 0;
		let most = 0;
		const judge = vi.fn<JudgeFn>(async () => {
			most = Math.max(most, ++inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return answer(true);
		});
		await screenAs("selfhost", judge);
		expect(most).toBe(SELFHOST_CLASSIFIER_SLOTS);
	});

	it("a self-host call may run to the screen's deadline, and a hosted call stops at 8 s", async () => {
		const timeouts = async (edition: "selfhost" | "hosted") => {
			const seen = new Set<number>();
			const judge = vi.fn<JudgeFn>(async (_t, _q, _th, ctx) => {
				seen.add(ctx.timeoutMs);
				return answer(false);
			});
			await screenAs(edition, judge);
			return [...seen];
		};
		// The deadline is sized from the calls (guardOperationDeadlineMs), never under the 20 s floor.
		const selfhost = await timeouts("selfhost");
		expect(selfhost).toHaveLength(1);
		expect(selfhost[0]).toBeGreaterThanOrEqual(20000);
		expect(await timeouts("hosted")).toEqual([8000]);
	});

	it("a hosted edition asks every rule once and never the first pass", async () => {
		const { judge, asked } = await judgeWith(false);
		const { rules } = await screenAs("hosted", judge);
		expect(asked.filter((q) => groupByQuery.has(q) || SELFHOST_FIRST_PASSES.some((g) => g.name === q))).toEqual([]);
		expect(asked).toHaveLength(rules.length);
	});

	it("the paired screen asks no group question, since it routes each query by its rule", async () => {
		const { judge, asked } = await judgeWith(false);
		const { result, rules } = await screenAs("selfhost", judge, "qwen3guard");
		expect(asked.sort()).toEqual(rules.map((r) => r.key).sort());
		expect(result.status).toBe("safe");
	});
});

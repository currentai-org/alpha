import { describe, expect, it, vi } from "vitest";
import { MessageUpdateType, type MessageUpdate } from "$lib/chat/types/MessageUpdate";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: (_key: string, fallback: () => boolean) => fallback() }));

import { WINDOW_WORDS, createLoopCounter, cutRepetitionLoop, type LoopCutOptions } from "./loopCut";
import { DEGENERATE_REPETITION_FALLBACK_MESSAGE, repetitionNotice } from "./repetitionGuard";
import { DECLINE_LANGUAGES, type DeclineLanguage } from "$lib/chat/server/declineCopy";

const countAll = (tokens: string[]) => {
	const counter = createLoopCounter();
	return tokens.map((t) => counter.push(t)).find((hit) => hit !== null) ?? null;
};

async function run(tokens: string[], language?: Promise<DeclineLanguage>, options?: LoopCutOptions) {
	let pulled = 0;
	let returned = false;
	async function* source(): AsyncGenerator<MessageUpdate> {
		try {
			for (const token of tokens) {
				pulled++;
				yield { type: MessageUpdateType.Stream, token };
			}
			yield { type: MessageUpdateType.FinalAnswer, text: tokens.join(""), interrupted: false };
		} finally {
			returned = true;
		}
	}
	const out: MessageUpdate[] = [];
	for await (const e of cutRepetitionLoop(source(), language, options)) out.push(e);
	const final = out.find((e) => e.type === MessageUpdateType.FinalAnswer);
	return { out, final: final && "text" in final ? final.text : undefined, pulled, returned };
}

describe("cutRepetitionLoop stops a looping answer while it streams (CUR-3318)", () => {
	it("stops reading the model within one window of the loop starting and ends with the fixed notice", async () => {
		const loop = Array.from({ length: 2000 }, () => "No crushing. No smashing. No breaking. ");
		const { final, pulled, returned } = await run(["The room closes at 19:40. ", ...loop]);
		// Six words a token, so a window's worth of tokens plus the opening sentence.
		expect(pulled).toBeLessThanOrEqual(Math.ceil(WINDOW_WORDS / 6) + 2);
		expect(returned).toBe(true);
		expect(final).toContain("19:40");
		expect(final!.endsWith(DEGENERATE_REPETITION_FALLBACK_MESSAGE)).toBe(true);
	});

	it("counts a span split across tokens mid-word", () => {
		const text = "No crushing. No smashing. No breaking. ".repeat(WINDOW_WORDS / 3);
		const tokens = text.match(/.{1,3}/gs)!;
		expect(countAll(tokens)).not.toBeNull();
	});

	it("passes an ordinary answer through untouched, FinalAnswer included", async () => {
		const tokens = ["The reading room ", "closes at **19:40** ", "on Thursdays."];
		const { out } = await run(tokens);
		expect(out.at(-1)).toEqual({ type: MessageUpdateType.FinalAnswer, text: tokens.join(""), interrupted: false });
		expect(out.filter((e) => e.type === MessageUpdateType.Stream)).toHaveLength(3);
	});
});

describe("cutRepetitionLoop leaves repetition a person asked for (CUR-3318, CUR-1104 Observed 6)", () => {
	it("keeps three bullets that each open with the same title", () => {
		const bullet = "- Things Fall Apart by Chinua Achebe is a novel about change.\n";
		expect(countAll([bullet.repeat(3)])).toBeNull();
	});

	it("keeps a week of opening hours that differ only in their times", () => {
		const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
		const week = days.map((d, i) => `- The reading room closes at ${17 + (i % 3)}:${i}0 on ${d}.\n`).join("");
		expect(countAll([week, week.replace(/on /g, "each ")])).toBeNull();
	});

	it("keeps eight days that each repeat the same sentence after the day's name", () => {
		const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Holidays"];
		expect(countAll([days.map((d) => `- ${d}: The museum is open from 9 to 5.\n`).join("")])).toBeNull();
	});

	it("keeps a recipe whose steps share a refrain", () => {
		const items = ["onion", "garlic", "carrot", "celery", "pepper", "tomato", "lentils", "stock", "spinach", "lemon"];
		const steps = items.map((x, i) => `${i + 1}. Add the ${x}, stir well and cook for two minutes over a medium heat.\n`);
		expect(countAll([steps.join("")])).toBeNull();
	});

	it("keeps a poem whose chorus returns between verses", () => {
		const chorus = "Oh the river runs and the river turns, and the river carries home the light we lost along the way.\n";
		const verses = [
			"The miller woke before the dawn and walked the frozen lane to see the wheel.\n",
			"His daughter sang a song her mother taught her on the morning of the flood.\n",
			"The children gather stones along the bank and count them out in twos and threes.\n",
			"When evening comes the lamps are lit in every window facing down the valley.\n",
		];
		expect(countAll([verses.map((v) => v + chorus + chorus).join("")])).toBeNull();
	});

	// The agent's trace ends with its summary and the answer after </think> is that summary
	// again, so a correct answer with files must not end in the loop notice. (CUR-4105)
	const summary =
		"**Files written:**\n- `monthly_totals_with_pct_change.csv`: monthly totals with a percentage change column, amounts rounded to 2 decimals.\n" +
		"- `annual_report_summary.txt`: a 5-line summary for the annual report.\n" +
		"**Checked:**\n- All amounts rounded to 2 decimals.\n- Percentage change calculated and rounded.\n" +
		"- Summary fits 5 lines and includes the total, best month, and trend description.\n" +
		"**Left:**\nNothing. Task complete.\n";
	const trace = "<think>\nWorking on it via the open agent…\n→ step 1: execute\n   completed\nRan 3 step(s).\n---\n";

	it("keeps an agent answer that restates the summary its reasoning ended with", () => {
		expect(countAll([trace + summary + "</think>\n---\n" + summary])).toBeNull();
	});

	it("keeps it when the closing tag arrives split across tokens", () => {
		const text = trace + summary + "</think>\n---\n" + summary;
		expect(countAll(text.match(/.{1,3}/gs)!)).toBeNull();
	});

	it("still cuts a loop that starts after the reasoning ends", () => {
		const loop = "No crushing. No smashing. No breaking. ".repeat(WINDOW_WORDS / 3);
		expect(countAll([trace + summary + "</think>\n", summary, loop])).not.toBeNull();
	});

	it("does not count repeats inside a code fence", () => {
		const code = "```\n" + "print('hello world again and again')\n".repeat(30) + "```\nDone.";
		expect(countAll([code])).toBeNull();
	});
});

describe("the loop notice reads in the language the person wrote in (CUR-4052)", () => {
	const loop = Array.from({ length: 200 }, () => "Je ne peux pas lire. Je ne peux pas lire. ");

	it("ends a French turn's looping answer with the French notice, not the English one", async () => {
		const { final } = await run(["Voici vos fichiers. ", ...loop], Promise.resolve("fr"));
		expect(final!.endsWith(repetitionNotice("fr"))).toBe(true);
		expect(final).not.toContain(DEGENERATE_REPETITION_FALLBACK_MESSAGE);
	});

	it("falls back to English when the turn's language is unknown", async () => {
		const { final } = await run(["Voici vos fichiers. ", ...loop]);
		expect(final!.endsWith(DEGENERATE_REPETITION_FALLBACK_MESSAGE)).toBe(true);
	});

	it("has a notice for every language a decline is translated into, none of them the English text", () => {
		for (const lang of DECLINE_LANGUAGES) {
			expect(repetitionNotice(lang), lang).toBeTruthy();
			expect(repetitionNotice(lang), lang).not.toBe(DEGENERATE_REPETITION_FALLBACK_MESSAGE);
		}
	});
});

// An agent narrates between its own file checks in near-identical sentences. A cut that
// fires inside <think>, before </think>, loses the answer and the file, and the page shows "No answer
// was produced". (CUR-4105)
describe("an agent turn's step trace is not read for loops (CUR-4105)", () => {
	const restate =
		"Created `hong_kong_neighbourhoods.xlsx` with a table comparing the 5 neighbourhoods on rent (HKD), commute to Central (minutes), and feel, plus a bar chart of the rents. All rent and commute figures are illustrative estimates, marked as such in the file.\n\n" +
		"`hong_kong_neighbourhoods.xlsx` is in your working directory. It contains a table comparing Kennedy Town, Sai Ying Pun, Tai Koo, Sha Tin, and Discovery Bay on typical 2-bedroom rent (HKD), commute to Central (minutes), and feel, plus a bar chart of the rents. All rent and commute figures are illustrative estimates, marked as such in the file.\n\n" +
		"`hong_kong_neighbourhoods.xlsx` contains a table comparing Kennedy Town, Sai Ying Pun, Tai Koo, Sha Tin, and Discovery Bay on typical 2-bedroom rent (HKD), commute to Central (minutes), and feel, plus a bar chart of the rents. All rent and commute figures are illustrative estimates, marked as such in the file.\n\n";
	const trace =
		"<think>\nWorking on it via the open agent…\n\n→ step 1: execute\n   completed\nRan 21 step(s) · 129531 tokens.\n" + restate;
	const answer = "</think>\nI made `hong_kong_neighbourhoods.xlsx`: five neighbourhoods with rent, commute and feel, and a bar chart of the rents.";
	const tokens = (trace + answer).match(/.{1,5}/gs)!;

	it("lets a finished agent turn through whole, answer and FinalAnswer included, when its trace restates the file three times", async () => {
		const { final, returned } = await run(tokens, undefined, { skipReasoning: true });
		expect(final).toBe(trace + answer);
		expect(returned).toBe(true);
	});

	it("still cuts a loop in the answer after the agent's trace", async () => {
		const loop = "No crushing. No smashing. No breaking. ".repeat(WINDOW_WORDS / 3);
		const { final } = await run([trace, answer, loop], undefined, { skipReasoning: true });
		expect(final!.endsWith(DEGENERATE_REPETITION_FALLBACK_MESSAGE)).toBe(true);
	});

	it("closes an open <think> before the notice when a cut lands inside reasoning, so the notice is the visible answer", async () => {
		const { final } = await run(tokens);
		expect(final).toBeDefined();
		const notice = final!.lastIndexOf(DEGENERATE_REPETITION_FALLBACK_MESSAGE);
		expect(notice).toBeGreaterThan(final!.lastIndexOf("</think>"));
		expect(final!.lastIndexOf("</think>")).toBeGreaterThan(-1);
	});
});

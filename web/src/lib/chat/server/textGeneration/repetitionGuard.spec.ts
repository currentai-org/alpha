import { describe, it, expect } from "vitest";
import { detectDegenerateRepetition, REPETITION_MIN_OCCURRENCES } from "./repetitionGuard";

// Real captures (CUR-1104), not synthesised
// text — the same real-capture discipline degeneration.ts's
// own suite uses. All three came from the same prompt, "Bawo ni, se o le ran mi lowo pelu nkankan?"
const WRECKS = {
	"run 1 (flag on)": `Bawo ni, se o le ran mi lowo pelu nkankan?
Nkaa, ndi o le ran mi lowo pelu nkankan. Ndi o le ran mi lowo pelu nkankan, ndi o le ran mi lowo pelu nkankan.`,
	"run 2 (flag off, byte-identical to run 1)": `Bawo ni, se o le ran mi lowo pelu nkankan?
Nkaa, ndi o le ran mi lowo pelu nkankan. Ndi o le ran mi lowo pelu nkankan, ndi o le ran mi lowo pelu nkankan.`,
	"run 3": `Bawo ni, se o le ran mi lowo pelu nkankan?
E, o le ran mi lowo pelu nkankan.
O le ran mi lowo pelu nkankan, se o le ran mi lowo pelu nkankan.`,
};

// Every one of these is an answer this product should be able to give, chosen to stress the specific
// risk an n-gram-repeat detector runs: legitimate short-phrase reuse. Not a copy of degeneration.ts's
// own LEGIT table (that one stresses symbol/markup density, a different axis) — this one stresses
// REPEATED PHRASING specifically, which is the axis this module actually measures.
const LEGIT: Record<string, string> = {
	"anaphora repeats a short lead-in, then diverges each time": `I have a dream that my four little children will one day live in a nation where they will not be judged by the color of their skin. I have a dream today that one day this nation will rise up and live out the true meaning of its creed.`,
	"parallel list items share a template but not a full 6-word span": `Feature A: shipped and stable. Feature B: shipped and stable. Feature C: shipped and stable, pending a follow-up audit.`,
	"assistant echoes part of the question once as an opener, then actually answers": `You asked whether the deploy finished — it did, at 14:02 UTC, and all health checks are green. No further action needed on your end right now.`,
	"markdown table repeats column labels across rows, not a prose span": `| engine | sources | latency |
| --- | --- | --- |
| Potluck | 4 | 210 ms |
| SyftHub | 2 | 460 ms |
| open web | 6 | 1240 ms |`,
	"repetitive code, fenced": `\`\`\`ts
retry(() => fetch(url));
retry(() => fetch(url));
retry(() => fetch(url));
\`\`\``,
	"plain prose, no repetition": `The closing speed is 270 km/h and the gap is 84 km, so they meet after about eighteen and two thirds minutes.`,
};

describe("detectDegenerateRepetition — the CUR-1104 probe", () => {
	it.each(Object.entries(WRECKS))("flags the real captured incident output (%s)", (_name, text) => {
		const v = detectDegenerateRepetition(text);
		expect(v.repeated).toBe(true);
		expect(v.count).toBeGreaterThanOrEqual(REPETITION_MIN_OCCURRENCES);
		expect(v.ngram).not.toBeNull();
	});

	it("flags none of the legitimate answers, including ones that deliberately reuse short phrases", () => {
		for (const [name, text] of Object.entries(LEGIT)) {
			const v = detectDegenerateRepetition(text);
			expect(v.repeated, `${name} must not be flagged (ngram: ${v.ngram}, count: ${v.count})`).toBe(
				false
			);
		}
	});

	it("does not judge fenced code — three identical lines of legitimate retry boilerplate", () => {
		expect(
			detectDegenerateRepetition("```ts\nretry(() => fetch(url));\nretry(() => fetch(url));\n```")
				.repeated
		).toBe(false);
	});

	it("requires the full n-gram window — two occurrences alone is not enough", () => {
		expect(
			detectDegenerateRepetition("the quick brown fox jumps over, the quick brown fox jumps over")
				.repeated
		).toBe(false);
	});

	it("degrades quietly on empty and undefined input rather than throwing on the answer path", () => {
		expect(detectDegenerateRepetition("").repeated).toBe(false);
		expect(detectDegenerateRepetition(undefined as unknown as string).repeated).toBe(false);
	});

	it("is case-insensitive — a degenerate loop does not always repeat with matching case", () => {
		expect(
			detectDegenerateRepetition(
				"Please help me with something today. please help me with something today. " +
					"PLEASE HELP ME WITH SOMETHING TODAY."
			).repeated
		).toBe(true);
	});
});

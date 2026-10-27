import { describe, it, expect } from "vitest";
import { measureDegeneration } from "./degeneration";

// The CUR-149 acceptance probe, running in the ordinary suite rather than as a live-model eval so it
// can go red on a pull request.
//
// The tail below is VERBATIM from a real degenerate answer (two-train arithmetic, ended mid-token
// on `\( m`). Keeping the real text rather than a synthesised one matters: a fixture invented
// here would be shaped to pass, and the thing worth pinning is that THIS output, which was
// logged as `outcome: complete`, is recognisable.
const WRECK = `9.5 × 150 = (9× 150)+(½× 150)= 1350+75= \`≈\` \`→\` \`=\` \`≈\` \`→\`
Divide by 30 → t ≈ (≈ \\( \\frac{9.5 \\times 15}{3} \\)) ≈ \\( \\frac{~ ( \\frac{9}{2} \\times
=> \`(30 - 12) min = **\\mathbf{+}\\,{\\color{gray} { }}\\) **\\mathbf{+}\\,\\boxed{\\mathbf{ }}\\) wait compute numeric value:

\\( m`;

// Every one of these is an answer this product should be able to give, and every one is dense
// enough to be a plausible false positive. This is the block that should stop any future tightening.
const LEGIT: Record<string, string> = {
	"dense LaTeX": `The quadratic formula gives \\( x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a} \\). Substituting \\(a=2\\), \\(b=-7\\), \\(c=3\\) yields \\( x = \\frac{7 \\pm \\sqrt{49-24}}{4} = \\frac{7 \\pm 5}{4} \\), so \\( x = 3 \\) or \\( x = \\tfrac{1}{2} \\).`,
	"markdown table": `| engine | sources | latency |
| --- | --- | --- |
| Potluck | 4 | 210 ms |
| SyftHub | 2 | 460 ms |
| open web | 6 | 1240 ms |`,
	"inline code prose": `Call \`sem.run(() => handle(i))\` inside \`Promise.all(items.map(...))\`; the \`Semaphore(4)\` bounds concurrency to four, and \`await\` on the outer promise resolves once every handler settles.`,
	"citation dense": `Mistral [1], BLOOM [2], Apertus [3] and Falcon [4] are open-weight. See [1][2][3][4] for the licences, and [2][4] for the training-data statements.`,
	"repetitive code": `Call \`sem.run()\` then \`sem.run()\` again; each \`sem.run()\` acquires a slot before the handler starts.`,
	"plain prose": `The closing speed is 270 km/h and the gap is 84 km, so they meet after about eighteen and two thirds minutes, which is 09:48:40.`,
	"cyrillic": `Семафор — это примитив синхронизации, ограничивающий число потоков, одновременно обращающихся к общему ресурсу.`,
	"japanese": `セマフォは、共有リソースに同時にアクセスできるスレッドの数を制限する同期プリミティブです。`,
};

describe("measureDegeneration — the CUR-149 probe", () => {
	it("flags the verbatim incident output that prod logged as a clean completion", () => {
		const v = measureDegeneration(WRECK);
		expect(v.degenerate).toBe(true);
		expect(v.emptyGroups).toBeGreaterThan(0);
	});

	it("flags none of the legitimate answers, including the ones denser than the wreck", () => {
		for (const [name, text] of Object.entries(LEGIT)) {
			const v = measureDegeneration(text);
			expect(v.degenerate, `${name} must not be flagged (emptyGroups ${v.emptyGroups})`).toBe(
				false
			);
		}
	});

	// A bound on non-alphanumeric ratio CANNOT work: the dense-LaTeX answer scores at or above the
	// wreck, so every threshold either misses the wreck or kills the derivation. Asserting the
	// ordering keeps the reason in the suite rather than in a comment nothing can contradict.
	it("records why a symbol-ratio threshold was rejected: a real derivation scores as high", () => {
		const wreck = measureDegeneration(WRECK).symbolRatio;
		const latex = measureDegeneration(LEGIT["dense LaTeX"]).symbolRatio;
		// Within a tenth of each other in either direction — indistinguishable, which is the point.
		// No threshold placed between these two numbers survives contact with a third sample.
		expect(Math.abs(latex - wreck) / Math.max(latex, wreck)).toBeLessThan(0.1);
		// …and the signal that does separate them is unambiguous at the same time.
		expect(measureDegeneration(WRECK).emptyGroups).toBeGreaterThan(0);
		expect(measureDegeneration(LEGIT["dense LaTeX"]).emptyGroups).toBe(0);
	});

	// Fences are excised BEFORE measuring. A brace-heavy snippet is content, and judging code as
	// prose is the fastest route to suppressing a good answer.
	it("does not judge fenced code — a snippet full of empty braces is content, not collapse", () => {
		const withCode = `Here is the shape:

\`\`\`ts
const empty = {};
const nested = { inner: {} };
type Noop = Record<string, {}>;
\`\`\`

That compiles, though \`{}\` as a type means "any non-nullish value" rather than "empty object".`;
		expect(measureDegeneration(withCode).degenerate).toBe(false);
	});

	it("degrades quietly on empty and undefined input rather than throwing on the answer path", () => {
		expect(measureDegeneration("").degenerate).toBe(false);
		expect(measureDegeneration(undefined as unknown as string).degenerate).toBe(false);
	});
});

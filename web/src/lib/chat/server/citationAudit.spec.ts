import { describe, it, expect } from "vitest";
import { auditCitations } from "./citationAudit";

const sources = (n: number) => ({ sources: Array.from({ length: n }, (_, i) => ({ n: i + 1 })) });

describe("auditCitations — is a grounded turn actually citing what it was given", () => {
	it("flags the live defect: sources supplied, answer cites none (CUR-151)", () => {
		// A representative shape: eight web sources attached, an answer
		// that is correct and carries no marker at all.
		const audit = auditCitations({
			text: "The EU AI Act entered into force on 1 August 2024 and is the world's first comprehensive legal framework for artificial intelligence.",
			webSearch: sources(8),
		});
		expect(audit.grounded).toBe(true);
		expect(audit.sourceCount).toBe(8);
		expect(audit.citationCount).toBe(0);
		expect(audit.uncited).toBe(true);
	});

	it("does not flag a cited answer, and counts distinct sources separately from total markers", () => {
		// distinctCited is the figure that means something when one source carries most of an answer:
		// four markers over two sources is not the same as four markers over four.
		const audit = auditCitations({
			text: "Zurich had 436,551 residents [1]. The urban area held 1.45 million [2], and the metro 2.1 million [2]. Both figures are 2020 [1].",
			webSearch: sources(4),
		});
		expect(audit.citationCount).toBe(4);
		expect(audit.distinctCited).toBe(2);
		expect(audit.uncited).toBe(false);
	});

	it("counts RAG and web sources together — a turn grounded on either owes citations", () => {
		const audit = auditCitations({ text: "No markers here.", rag: sources(2), webSearch: sources(3) });
		expect(audit.sourceCount).toBe(5);
		expect(audit.uncited).toBe(true);
	});

	it("an UNGROUNDED turn is never uncited — there was nothing to cite", () => {
		// The metric has to mean "was given sources and ignored them". Counting a training-data answer
		// as a citation failure would bury the real signal under every ordinary turn.
		const audit = auditCitations({ text: "The sky is blue because of Rayleigh scattering." });
		expect(audit.grounded).toBe(false);
		expect(audit.uncited).toBe(false);
	});

	it("a guard-REPLACED answer is not scored as cited, and not scored as uncited either", () => {
		// buildGroundedHedgeReplacement writes "[1] Title, [2] Title" itself. Counting that as model
		// compliance would make the metric read HEALTHIEST exactly when the model answered worst —
		// the whole answer having been thrown away. Neither branch applies to such a turn.
		const replacement =
			"I retrieved these sources but didn't write an answer from them this time: [1] EU AI Act, [2] Open web result.";
		const scored = auditCitations({
			text: replacement,
			webSearch: sources(2),
			replacedByGuard: true,
		});
		expect(scored.uncited).toBe(false);
		// ...and without the flag the same text WOULD have looked like a well-cited answer, which is
		// precisely the misreading the flag exists to prevent.
		const misread = auditCitations({ text: replacement, webSearch: sources(2) });
		expect(misread.citationCount).toBe(2);
		expect(misread.uncited).toBe(false);
	});

	it("handles an empty answer without claiming it cited anything", () => {
		const audit = auditCitations({ text: "", webSearch: sources(3) });
		expect(audit.citationCount).toBe(0);
		expect(audit.uncited).toBe(true);
	});

	// The contract these pin, named rather than described: a marker that names no real source must not
	// be able to clear `uncited`. If every `[n]` counted, the audit would report its worst case as its
	// healthiest, and no amount of extra coverage of well-formed answers would show it.
	it("an out-of-range marker is dangling, NOT a citation — [7] against three sources cites nothing", () => {
		const audit = auditCitations({
			text: "Switzerland held the referendum in March [7], and turnout was 46% [9].",
			webSearch: sources(3),
		});
		expect(audit.citationCount).toBe(0);
		expect(audit.distinctCited).toBe(0);
		expect(audit.danglingCount).toBe(2);
		// The whole point: this turn cited none of what it was given, and says so.
		expect(audit.uncited).toBe(true);
	});

	it("`[0]` is dangling too — the grounding prompt numbers sources from 1", () => {
		const audit = auditCitations({ text: "As reported [0].", webSearch: sources(2) });
		expect(audit.citationCount).toBe(0);
		expect(audit.danglingCount).toBe(1);
		expect(audit.uncited).toBe(true);
	});

	it("a real citation alongside a fabricated one still counts as cited, and reports both", () => {
		// Not `uncited` — the turn did cite something it was handed. The fabricated marker is a separate
		// finding, which is exactly why it gets a separate field instead of moving this boolean.
		const audit = auditCitations({
			text: "The figure is 436,551 [1], revised in the follow-up study [8].",
			webSearch: sources(3),
		});
		expect(audit.citationCount).toBe(1);
		expect(audit.danglingCount).toBe(1);
		expect(audit.uncited).toBe(false);
	});
});

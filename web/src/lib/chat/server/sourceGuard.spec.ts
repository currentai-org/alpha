import { describe, expect, it } from "vitest";
import {
	detectFabricatedSources,
	stripTrailingSourceList,
	stripTrailingTitleDump,
	type TrailingSourceListSource,
} from "$lib/chat/server/sourceGuard";

describe("detectFabricatedSources — never let fabricated/fictional sources reach the user", () => {
	it("strips a 'these sources are fictional/hypothetical examples' disclaimer (any turn)", () => {
		const text =
			"The EU AI Act entered into force in 2024. Note: these sources are hypothetical examples; actual releases may vary.";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("The EU AI Act entered into force in 2024.");
		expect(cleaned).not.toMatch(/hypothetical|fictional/i);
	});

	it("strips the 'fictional examples created to demonstrate' disclaimer", () => {
		const text =
			"Open models advanced in 2025. Please note that these sources are fictional examples created to demonstrate the format.";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("Open models advanced in 2025.");
	});

	it("strips a trailing fabricated 'Sources:' bibliography on a grounded turn", () => {
		const text =
			'The EU AI Act entered into force in 2024 and covers high-risk systems.\n\nSources:\n[1] Meta AI Blog: "LLaMA 2" (July 2025)\n[2] Mistral AI Blog (May 2025)';
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("The EU AI Act entered into force in 2024 and covers high-risk systems.");
		expect(cleaned).not.toMatch(/Sources:|Meta AI Blog/);
	});

	it("cuts an INLINE 'Sources:' label to EOF when it introduces a mixed URL + title dump", () => {
		const text =
			"AI policy momentum continued across the EU and US throughout the year. Sources: " +
			"https://ec.europa.eu/ai-act [1] https://openai.com/blog/example [2] " +
			"European Commission AI Act Overview - EU  OpenAI Blog - OpenAI";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"AI policy momentum continued across the EU and US throughout the year."
		);
		expect(cleaned).not.toMatch(/Sources:|https?:\/\/|Overview|OpenAI Blog/);
	});

	it("does NOT cut a prose 'three sources:' that introduces a plain list (no marker/URL)", () => {
		const text =
			"The grid draws on three sources: solar, wind, and hydro, balanced across the day and night.";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT cut an inline label whose remainder is prose, even if a LATER sentence has a [n]", () => {
		// The marker/URL evidence must be LOCAL to the label: "References: see appendix." is prose; a [1]
		// in a subsequent substantive sentence must not license a cut-to-EOF.
		const text =
			"The summary is organized as follows. References: see appendix. The EU AI Act entered into force in 2024 [1] and the rest of this answer is substantive.";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("cuts a REAL later dump even when an earlier prose 'References:' label comes first", () => {
		// A prose label must not short-circuit the scan: keep it, but still cut at the later real dump.
		const text =
			"The summary is organized as follows. References: see appendix. The EU AI Act entered into force in 2024. " +
			"Sources: https://ec.europa.eu/ai-act [1] https://openai.com/blog/example [2] European Commission AI Act Overview - EU  OpenAI Blog - OpenAI";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"The summary is organized as follows. References: see appendix. The EU AI Act entered into force in 2024."
		);
		expect(cleaned).not.toMatch(/https?:\/\/|Overview|OpenAI Blog/);
	});

	it("cuts an inline 'Sources:' label introducing a FABRICATED multi-entry bibliography (no markers/URLs)", () => {
		const text =
			'The EU AI Act entered into force in 2024 and covers high-risk systems. Sources: Meta AI Blog: "LLaMA 2" (July 2025); Mistral AI Blog: "Open Models" (May 2025)';
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("The EU AI Act entered into force in 2024 and covers high-risk systems.");
		expect(cleaned).not.toMatch(/Sources:|Meta AI Blog|Mistral/);
	});

	it("strips a CRLF whole-line 'Sources:' heading block (newline-form robustness)", () => {
		const text =
			"The Act entered into force in 2024 and covers high-risk systems.\r\n## Sources:\r\n" +
			"[1] Current AI - Paris Charter\r\n[2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("The Act entered into force in 2024 and covers high-risk systems.");
	});

	it("does NOT strip a trailing 'Sources:' block on an ungrounded turn (grounded-only)", () => {
		const text = "Here is an overview of the topic in detail.\n\nReferences:\n[1] Some Book";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: false });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("leaves a clean grounded answer with inline [1][2] and no trailing list untouched", () => {
		const text =
			"The EU AI Act entered into force in 2024 [1] and phases in high-risk rules through 2027 [2].";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does not match the word 'sources' used mid-sentence", () => {
		const text = "Our sources say the rules take effect in 2026, which several outlets confirm.";
		const { flagged, cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("never empties the answer — bails to original if the strip would gut it", () => {
		const text = "These sources are fictional examples.";
		const { cleaned } = detectFabricatedSources(text, { grounded: true });
		expect(cleaned).toBe(text); // nothing substantive would survive → keep original
	});
});

describe("stripTrailingSourceList — the heading-less duplicate the SourceStrip already renders", () => {
	const sources: TrailingSourceListSource[] = [
		{ n: 1, title: "Current AI - Paris Charter" },
		{ n: 2, title: "EU AI Act | Shaping Europe's digital future" },
		{ n: 3, title: "Navigating the AI regulatory landscape" },
	];

	it("strips a trailing '[1] Title [2] Title [3] Title' block appended with no heading (the reported bug)", () => {
		const text =
			"The EU AI Act phases in high-risk obligations through 2027, and the Paris Charter sets shared open-AI principles. [1] Current AI - Paris Charter [2] EU AI Act | Shaping Europe's digital future [3] Navigating the AI regulatory landscape";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"The EU AI Act phases in high-risk obligations through 2027, and the Paris Charter sets shared open-AI principles."
		);
		expect(cleaned).not.toMatch(/\[1\]|\[2\]|\[3\]/);
	});

	it("strips the same block when the entries are on their own lines", () => {
		const text =
			"Open models advanced sharply in 2025 across the stack.\n\n[1] Current AI - Paris Charter\n[2] EU AI Act | Shaping Europe's digital future\n[3] Navigating the AI regulatory landscape";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe("Open models advanced sharply in 2025 across the stack.");
	});

	it("removes a dangling inline 'Sources:' label the whole-line heading guard can't catch", () => {
		const text =
			"The Act entered into force in 2024 and covers high-risk systems. Sources: [1] Current AI - Paris Charter [2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"The Act entered into force in 2024 and covers high-risk systems."
		);
		expect(cleaned).not.toMatch(/Sources:/i);
	});

	it("tolerates a truncated final title (model cut a long title short)", () => {
		const longSources: TrailingSourceListSource[] = [
			{ n: 1, title: "Current AI - Paris Charter" },
			{ n: 2, title: "Navigating the AI regulatory landscape and compliance obligations in 2025" },
		];
		const text =
			"Both frameworks stress open governance and shared safety obligations across the ecosystem. [1] Current AI - Paris Charter [2] Navigating the AI regulatory landscape";
		const { flagged, cleaned } = stripTrailingSourceList(text, longSources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"Both frameworks stress open governance and shared safety obligations across the ecosystem."
		);
	});

	it("leaves ordinary inline citations that end in punctuation untouched", () => {
		const text =
			"The EU AI Act entered into force in 2024 [2] and phases in high-risk rules through 2027 [3].";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip a genuine numbered enumeration that doesn't reproduce the source titles", () => {
		const text =
			"To get started, follow these steps in order and verify each one before moving on. [1] install the CLI [2] run the migration [3] restart the worker";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does not fire when the answer doesn't END on a matched source entry", () => {
		// A single reproduced title mid-answer, then prose after it — the tail isn't a bibliography.
		const text =
			"[1] Current AI - Paris Charter is the framework this answer draws on, and it remains the reference point for open-AI governance going forward.";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip an inline enumeration whose citations ARE the answer (open predicate before the list)", () => {
		// The head "…documents to read are" is an unfinished sentence — cutting would leave a broken
		// fragment. Only a list APPENDED to a finished sentence (terminal punctuation) is a bibliography.
		const text =
			"The two documents to read are [1] Current AI - Paris Charter and [2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("still matches a duplicate when a curly-apostrophe source title meets a straight-quote reproduction", () => {
		// Source title uses typographic ’, the model reproduces it with ASCII ' — normalization must fold
		// both to the same token or the last entry fails and the whole strip bails.
		const curlySources: TrailingSourceListSource[] = [
			{ n: 1, title: "Current AI - Paris Charter" },
			{ n: 2, title: "EU AI Act | Shaping Europe’s digital future" },
		];
		const text =
			"Summary sentence with more than enough retained content to survive the floor. [1] Current AI - Paris Charter [2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = stripTrailingSourceList(text, curlySources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"Summary sentence with more than enough retained content to survive the floor."
		);
	});

	it("stands down on an ungrounded turn (real sources render only when a search ran)", () => {
		const text =
			"Here is a general overview of the topic. [1] Current AI - Paris Charter [2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: false });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("requires at least two matched entries (a lone trailing title is left alone)", () => {
		const text =
			"The Paris Charter sets shared open-AI principles for the ecosystem. [1] Current AI - Paris Charter";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("never guts the answer — bails to original when too little would remain", () => {
		const text = "[1] Current AI - Paris Charter [2] EU AI Act | Shaping Europe's digital future";
		const { flagged, cleaned } = stripTrailingSourceList(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});
});

describe("stripTrailingTitleDump — the marker-less run of reproduced titles", () => {
	const sources: TrailingSourceListSource[] = [
		{ n: 1, title: "FIFA World Cup 2026" },
		{ n: 2, title: "IPCC Sixth Assessment Report" },
		{ n: 3, title: "NASA Artemis Program" },
		{ n: 4, title: "GPT-4 Release" },
		{ n: 5, title: "Monkeypox Outbreak" },
	];

	it("strips a single-marker title run reproduced as 'Title – Publisher …' (the reported bug)", () => {
		const text =
			"Meta is developing advanced brain-computer interfaces that could revolutionize accessibility and communication technology. " +
			"[1] FIFA World Cup 2026 – Wikipedia  IPCC Sixth Assessment Report – Intergovernmental Panel on Climate Change  " +
			"NASA Artemis Program – NASA  GPT-4 Release – OpenAI Blog  Monkeypox Outbreak – WHO Situation Reports";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"Meta is developing advanced brain-computer interfaces that could revolutionize accessibility and communication technology."
		);
		expect(cleaned).not.toMatch(/FIFA|IPCC|Artemis|GPT-4|Monkeypox|\[1\]/);
	});

	it("strips a markerless title run introduced by a 'Sources:' label", () => {
		const text =
			"Here is a concise roundup of the major developments across science and technology this year. Sources: " +
			"IPCC Sixth Assessment Report – IPCC | NASA Artemis Program – NASA | GPT-4 Release – OpenAI Blog";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(true);
		expect(cleaned).toBe(
			"Here is a concise roundup of the major developments across science and technology this year."
		);
		expect(cleaned).not.toMatch(/Sources:|IPCC|Artemis|GPT-4/);
	});

	it("does NOT strip a markerless, label-less title run (indistinguishable from a user-requested list)", () => {
		// P1b: a legitimate source comparison the user asked for — no leading marker, no "Sources:" label.
		const text =
			"Use these two references for the audit.\n" +
			"IPCC Sixth Assessment Report - regulatory basis\n" +
			"NASA Artemis Program - mission scope";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip a final sentence that names two sources, even with an em dash in the prose", () => {
		// P1a: the em dash sits in ordinary prose after the second title, not between title entries; the
		// per-gap separator check (the "and" gap has none) keeps this legitimate sentence intact.
		const text =
			"Short summary of the evidence base. IPCC Sixth Assessment Report and NASA Artemis Program – both are central to current policy debates.";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT match a source title inside a longer word (word-boundary anchoring)", () => {
		// P2: "AI Act" must not match "AI action"; "New York" must not match "New Yorkers".
		const shortSources: TrailingSourceListSource[] = [
			{ n: 1, title: "AI Act" },
			{ n: 2, title: "New York" },
		];
		const text =
			"Overview is complete. AI action plans help New Yorkers – especially early-stage teams building tools.";
		const { flagged, cleaned } = stripTrailingTitleDump(text, shortSources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip ordinary prose that merely names two sources (no list separator)", () => {
		const text =
			"The two documents worth reading are the IPCC Sixth Assessment Report and the NASA Artemis Program overview, both released recently.";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT treat a prose sentence ending in 'references:' as a Sources label", () => {
		// The word "references:" here is the tail of a sentence, not a standalone list introducer, so it
		// must not license a strip that leaves the broken fragment "The answer can point to two official".
		const text =
			"The answer can point to two official references: " +
			"IPCC Sixth Assessment Report – IPCC | NASA Artemis Program – NASA";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT fire when only one title is reproduced at the end", () => {
		const text =
			"The most relevant reference for this question is the IPCC Sixth Assessment Report – IPCC";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT fire when a real sentence follows the titles (a mid-answer mention, not a trailing dump)", () => {
		const text =
			"Two key references are the IPCC Sixth Assessment Report | NASA Artemis Program. These both inform current policy debates in meaningful ways.";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("stands down on an ungrounded turn", () => {
		const text =
			"A quick overview of recent events for context. IPCC Sixth Assessment Report – IPCC | NASA Artemis Program – NASA";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: false });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("bails to original when stripping would gut the answer (floor, even with a Sources: label)", () => {
		const text = "Sources: IPCC Sixth Assessment Report – IPCC | NASA Artemis Program – NASA";
		const { flagged, cleaned } = stripTrailingTitleDump(text, sources, { grounded: true });
		expect(flagged).toBe(false);
		expect(cleaned).toBe(text);
	});
});

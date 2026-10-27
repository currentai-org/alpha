import { describe, it, expect } from "vitest";
import { detectRecencyHedge, buildGroundedHedgeReplacement, hasSubstantiveText, splitSentences } from "./hedgeGuard";
import { readMessageLanguage } from "./declineCopy";

describe("detectRecencyHedge", () => {
	it("strips a trailing 'consult recent sources' recency hedge", () => {
		const text =
			"Argentinosaurus is the largest known dinosaur, at roughly 70-100 tons. For the latest estimates, consult recent paleontology research.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).not.toMatch(/consult recent/i);
		expect(cleaned).toContain("Argentinosaurus is the largest known dinosaur");
	});

	it("strips an 'as of my last update' disclaimer", () => {
		const text =
			"As of my last update, the EU AI Act was in negotiation. It entered into force in 2024.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).not.toMatch(/as of my last update/i);
		expect(cleaned).toContain("It entered into force in 2024.");
	});

	it("strips a real-time-access capability disclaimer", () => {
		const text =
			"I can't access real-time information. The sources above indicate the law is now in force.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).not.toMatch(/can't access real-time/i);
		expect(cleaned).toContain("The sources above indicate the law is now in force.");
	});

	it("leaves a hedge-free grounded answer untouched", () => {
		const text = "The EU AI Act entered into force on 1 August 2024 and applies in phases.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip a substantive sentence that merely mentions training data", () => {
		const text = "Models like this are trained on large text datasets scraped from the web.";
		const { hedged } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
	});

	it("bails to the original when stripping would gut the answer, and flags bailedWholeAnswer", () => {
		// The only sentence IS the hedge — stripping leaves nothing, so `cleaned` keeps the original (we
		// never return an empty answer), but bailedWholeAnswer:true tells a grounded caller to take the
		// deterministic-replacement path instead of shipping the refusal verbatim. keptText is the (empty)
		// raw strip result behind that floor.
		const text = "My knowledge may be out of date, so this might have changed.";
		const { hedged, cleaned, keptText, bailedWholeAnswer } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe(text);
		expect(bailedWholeAnswer).toBe(true);
		expect(keptText.length).toBeLessThan(24); // < MIN_KEEP_CHARS
	});

	it("a MIXED answer (one hedge + real substance) does NOT bail — keptText is the useful remainder", () => {
		const text =
			"The EU AI Act entered into force in 2024. My knowledge may be out of date on the details.";
		const { hedged, cleaned, keptText, bailedWholeAnswer } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(bailedWholeAnswer).toBe(false);
		expect(keptText).toBe("The EU AI Act entered into force in 2024.");
		expect(cleaned).toBe(keptText); // not bailed → cleaned is the stripped useful text
	});

	it("a SHORT substantive answer (kept sentence BELOW MIN_KEEP_CHARS) is NOT bailed — residue preserved", () => {
		// A complete non-hedge sentence under the 24-char floor must not read as a whole-answer
		// refusal (the char-count conflation would replace it with a generic pointer, losing real content).
		const text = "It passed in 2024. My knowledge may be out of date.";
		const { hedged, keptText, bailedWholeAnswer } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(bailedWholeAnswer).toBe(false); // has substantive content...
		expect(keptText).toBe("It passed in 2024.");
		expect(keptText.length).toBeLessThan(24); // ...even though it's below MIN_KEEP_CHARS
	});

	it("bails when the only surviving text is bare citation markers — [n] digits aren't substance (live bug, 2026-07-04)", () => {
		// A grounded turn hedged, then tacked on bare citation numbers with no actual prose: "I don't have
		// access to real-time information. [1] [2]". The hedge sentence is stripped; naively testing
		// /[A-Za-z0-9]/ on what's left ("[1] [2]") finds the digits INSIDE the brackets and wrongly
		// concludes real content survived — so the caller shipped the literal string "[1] [2]" as the
		// whole persisted answer. Citation markers must be excluded from the substance check.
		const text = "I don't have access to real-time information on this. [1] [2]";
		const { hedged, keptText, bailedWholeAnswer } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(keptText).toBe("[1] [2]");
		expect(bailedWholeAnswer).toBe(true);
	});

	// The substance test was ASCII-only ([A-Za-z0-9]), so a non-Latin answer with any hedge
	// sentence stripped counted as "nothing left" and the grounded caller replaced the real answer with
	// the "I retrieved these sources" pointer. (CUR-4356)
	it("keeps an all-Arabic answer whose only removed sentence was a hedge (not bailed)", () => {
		const arabic = "عاصمة أندورا هي أندورا لا فيلا. ويتحدث سكانها الكتالونية لأنها اللغة الرسمية الوحيدة [1].";
		const { hedged, keptText, cleaned, bailedWholeAnswer } = detectRecencyHedge(
			`${arabic} My knowledge may be out of date.`
		);
		expect(hedged).toBe(true);
		expect(bailedWholeAnswer).toBe(false);
		expect(keptText).toBe(arabic);
		expect(cleaned).toBe(arabic);
	});

	it("keeps an all-Chinese answer whose only removed sentence was a hedge (not bailed)", () => {
		const chinese = "安道尔的首都是安道尔城。加泰罗尼亚语是那里唯一的官方语言[1]。";
		const { bailedWholeAnswer, keptText } = detectRecencyHedge(`${chinese} My knowledge may be out of date.`);
		expect(bailedWholeAnswer).toBe(false);
		expect(keptText).toBe(chinese);
	});

	it("keeps an all-Greek answer whose only removed sentence was a hedge (not bailed)", () => {
		const greek = "Η πρωτεύουσα της Ανδόρας είναι η Ανδόρα λα Βέγια.";
		const { bailedWholeAnswer, keptText } = detectRecencyHedge(`${greek} My knowledge may be out of date.`);
		expect(bailedWholeAnswer).toBe(false);
		expect(keptText).toBe(greek);
	});

	it("hasSubstantiveText counts letters in any script and never counts bare [n] markers", () => {
		expect(hasSubstantiveText("الكتالونية")).toBe(true);
		expect(hasSubstantiveText("加泰罗尼亚语")).toBe(true);
		expect(hasSubstantiveText("Ανδόρα")).toBe(true);
		expect(hasSubstantiveText("ภาษาคาตาลัน")).toBe(true);
		expect(hasSubstantiveText("कातालान")).toBe(true);
		expect(hasSubstantiveText("[1] [2]")).toBe(false);
		expect(hasSubstantiveText(" . ، ؟ ")).toBe(false);
	});

	it("splits sentences on Arabic and full-width terminal punctuation, so a strip lands on one sentence", () => {
		expect(splitSentences("ما هي عاصمة أندورا؟ إنها أندورا لا فيلا.")).toEqual([
			"ما هي عاصمة أندورا؟",
			"إنها أندورا لا فيلا.",
		]);
		expect(splitSentences("首都是安道尔城。官方语言是加泰罗尼亚语！")).toEqual(["首都是安道尔城。", "官方语言是加泰罗尼亚语！"]);
	});

	it("strips only the hedge bullet, keeping adjacent factual bullets (newline-separated, no terminal punctuation)", () => {
		// splitSentences breaks on newlines as well as terminal punctuation, so a bulleted block with no
		// trailing '.' is not one sentence: a hedge match on the middle bullet must not drop the heading
		// and the factual bullet with it. Each line is its own unit.
		const text =
			"Key points:\n- My knowledge may be out of date, so verify this\n- The EU AI Act entered into force in 2024";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toMatch(/entered into force in 2024/);
		expect(cleaned).not.toMatch(/knowledge may be out of date/);
	});

	it("does NOT strip a cited-source pointer (citation, not an advice-hedge)", () => {
		const text = "The law is now in force. For the latest figures, see [2].";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip a cited answer to a user asking which current sources to check", () => {
		const text =
			"For the current state of AI regulation before a board decision, check these sources: [2] The EU AI Act - current state of play and [4] AI Regulations around the World - 2026.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("does NOT strip a source-list intro that is about to enumerate retrieved sources", () => {
		const text = "For the current state of AI regulation before a board decision, check these sources:";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("strips a cutoff-DATE hedge ('based on my training data up until <date>')", () => {
		const text =
			"Rayleigh scattering makes the sky blue. I can provide information based on my training data up until 2026-06-24.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe("Rayleigh scattering makes the sky blue.");
		expect(cleaned).not.toMatch(/training data/i);
	});

	it("strips a 'please visit a reliable news source' recency-advice hedge", () => {
		const text =
			"The AI Act is now in force. For current news, please visit a reliable news source such as Google News.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe("The AI Act is now in force.");
	});

	it("strips a 'for MORE current information, consult...' hedge (words between for/current)", () => {
		const text =
			"The AI Act entered into force in 2024. For more current information, consult official EU sources or recent news updates.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe("The AI Act entered into force in 2024.");
	});

	it("strips a 'check official announcements or GitHub repositories' advice hedge", () => {
		const text =
			"Qwen 2.5 and Llama 3 were released recently. For the latest information, check official announcements or GitHub repositories.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe("Qwen 2.5 and Llama 3 were released recently.");
	});

	it("strips a 'since my last update' hedge (the points, not 'my knowledge', may have changed)", () => {
		const text =
			"The EU AI Act is now in force. Please verify these points with current sources as they may have changed since my last update.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(true);
		expect(cleaned).toBe("The EU AI Act is now in force.");
		expect(cleaned).not.toMatch(/since my last update/i);
	});

	it("does NOT strip a benign 'up to' with no cutoff year", () => {
		const text = "My training covers up to advanced calculus in real depth.";
		const { hedged, cleaned } = detectRecencyHedge(text);
		expect(hedged).toBe(false);
		expect(cleaned).toBe(text);
	});

	it("handles empty input", () => {
		expect(detectRecencyHedge("")).toEqual({
			hedged: false,
			cleaned: "",
			keptText: "",
			bailedWholeAnswer: false,
		});
	});
});

describe("buildGroundedHedgeReplacement — deterministic honest pointer for a bailed grounded refusal", () => {
	it("lists the combined RAG+web sources by their citation number + title", () => {
		const out = buildGroundedHedgeReplacement([
			{ n: 1, title: "EU AI Act" },
			{ n: 2, title: "Open web result" },
		]);
		expect(out).toContain("[1] EU AI Act");
		expect(out).toContain("[2] Open web result");
		// Never claims to have answered — it points at the retrieved sources instead.
		expect(out).toMatch(/didn't write an answer/i);
	});

	// The contract, not the wording: this line is emitted precisely when the model READ these sources
	// and declined to answer from them, so any claim about their quality is a claim the code cannot
	// support. Copy that opened "I found sources relevant to this question" would put that
	// sentence over a YouTube link (CUR-148). Rewording is fine; characterising the sources is not.
	it("never characterises the sources as relevant/useful/helpful — it has no basis for that claim", () => {
		const withSources = buildGroundedHedgeReplacement([{ n: 1, title: "Some page" }]);
		const withoutSources = buildGroundedHedgeReplacement([]);
		for (const out of [withSources, withoutSources]) {
			expect(out).not.toMatch(/\brelevant\b/i);
			expect(out).not.toMatch(/\buseful\b/i);
			expect(out).not.toMatch(/\bhelpful\b/i);
			expect(out).not.toMatch(/\bon-topic\b/i);
		}
	});

	it("caps the listed sources at 6 (a long source list doesn't bloat the pointer)", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, title: `S${i + 1}` }));
		const out = buildGroundedHedgeReplacement(many);
		expect(out).toContain("[6] S6");
		expect(out).not.toContain("[7] S7");
	});

	it("falls back to a source-less line for a vault-synthesis-only turn (no citable sources)", () => {
		const out = buildGroundedHedgeReplacement([]);
		expect(out).not.toMatch(/\[\d+\]/); // no citation markers to fabricate
		expect(out).toMatch(/reference material/i);
		// Must NOT claim openable/visible source chips — a vault-only turn has none.
		expect(out).not.toMatch(/open them|shown with this message/i);
	});
});

// The line "I retrieved these sources but didn't write an answer" is localised to the chat language. (CUR-4339)
describe("buildGroundedHedgeReplacement — reads in the language the person wrote in", () => {
	const sources = [
		{ n: 1, title: "Wikipedia" },
		{ n: 2, title: "BBC Amharic" },
	];

	it("answers an Amharic chat in Amharic, with the sources joined by the Ethiopic comma", async () => {
		const tag = await readMessageLanguage("የኢትዮጵያ ዋና ከተማ ማን ናት?");
		const out = buildGroundedHedgeReplacement(sources, tag);
		expect(out).toContain("ምንጮች");
		expect(out).toContain("[1] Wikipedia፣ [2] BBC Amharic");
		expect(out).not.toMatch(/retrieved/);
	});

	it("answers French in French and an Egyptian Arabic tag in Arabic", () => {
		expect(buildGroundedHedgeReplacement(sources, "fra")).toMatch(/^J'ai consulté ces sources/);
		expect(buildGroundedHedgeReplacement(sources, "arz")).toContain("المصادر");
		expect(buildGroundedHedgeReplacement([], "amh")).toContain("የምንጭ ዝርዝር የለም");
	});

	it("stays in English for no tag or a language it has no copy for", () => {
		expect(buildGroundedHedgeReplacement(sources)).toMatch(/^I retrieved these sources/);
		expect(buildGroundedHedgeReplacement(sources, "swh")).toMatch(/^I retrieved these sources/);
	});
});

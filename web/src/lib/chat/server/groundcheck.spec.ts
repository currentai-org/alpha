import { describe, it, expect, vi } from "vitest";
import {
	GROUNDCHECK_FAULT_EVIDENCE,
	groundcheckAnswer,
	groundcheckFaultCheck,
	groundcheckEmptiedText,
	groundcheckEvidence,
	groundcheckItemsRemovedText,
	listBlocks,
	cutsMidClause,
	cutsLoneNumber,
	dropsCitation,
	deletesUnmarkedWords,
	restoreClosingMarkers,
	unsourcedTail,
	emptiesUnrelatedSentence,
	deletesSourcedWords,
	isWordDeletion,
	parseReviseArgs,
	segmentUnits,
	MAX_FLAGGED_UNITS,
	REVISE_TOOL_NAME,
	type DetectCall,
	type DetectSpan,
	type ReviseCall,
} from "./groundcheck";

const quiet = { info: () => {}, warn: () => {} };
const context = ["[1] Lucie 7B — OpenLLM. A 7B model trained on English text, 15 trillion tokens."];
const question = "Which open models come from European labs?";

/** A span covering the first occurrence of `needle` in `answer`. */
function spanOf(answer: string, needle: string, confidence = 0.9): DetectSpan {
	const start = answer.indexOf(needle);
	if (start < 0) throw new Error(`fixture: "${needle}" not in answer`);
	return { start, end: start + needle.length, text: needle, confidence };
}
const detecting =
	(spans: (answer: string) => DetectSpan[], truncated = false): DetectCall =>
	async ({ answer }) => ({ spans: spans(answer), truncated });
const revising =
	(byId: Record<number, string>): ReviseCall =>
	async () =>
		new Map(Object.entries(byId).map(([k, v]) => [Number(k), v]));

describe("isWordDeletion", () => {
	it("accepts a revision whose words are an in-order subset of the original", () => {
		expect(isWordDeletion("Lucie 7B — France, from OpenLLM-France [1].", "Lucie 7B, from OpenLLM-France [1].")).toBe(
			true
		);
	});
	it("rejects a revision that adds a word the original did not have", () => {
		expect(isWordDeletion("Lucie 7B is from France.", "Lucie 7B is from Europe.")).toBe(false);
	});
	it("rejects a revision that reorders words", () => {
		expect(isWordDeletion("Built in Paris by OpenLLM.", "Built by OpenLLM in Paris.")).toBe(false);
	});
	it("rejects an unchanged sentence, since a deletion must drop at least one word", () => {
		expect(isWordDeletion("Lucie 7B is open.", "Lucie 7B is open!")).toBe(false);
	});
	it("accepts deleting the whole sentence", () => {
		expect(isWordDeletion("It is French.", "")).toBe(true);
	});
	it("rejects a revision that cuts a word at its possessive, leaving a stray apostrophe", () => {
		expect(isWordDeletion("Consult the Swiss AI Institute's model card [1].", "Consult the Swiss AI' [1].")).toBe(false);
	});
});

describe("deletesSourcedWords", () => {
	const sourceWords = new Set(["apertus", "trained", "trillion", "tokens", "15", "languages", "1800"]);
	it("is true (keep the sentence) when the deletion drops a number the sources state", () => {
		expect(deletesSourcedWords("Trained on 15 trillion tokens.", "Trained on tokens.", sourceWords)).toBe(true);
	});
	it("is true when at least half the dropped content words are in the sources", () => {
		expect(deletesSourcedWords("Apertus, trained on languages, is open.", "Apertus is open.", sourceWords)).toBe(
			true
		);
	});
	it("judges each deleted run alone, so an unsupported clause cannot outvote a sourced one", () => {
		const sourced = new Set(["cyberspace", "regulator", "under"]);
		expect(
			deletesSourcedWords(
				"Guidance for firms handling recruitment or credit scoring, under its cyberspace regulator.",
				"Guidance, its.",
				sourced
			)
		).toBe(true);
	});
	it("is false (allow the deletion) when the dropped words are absent from the sources", () => {
		expect(deletesSourcedWords("Apertus is from Lugano, Switzerland.", "Apertus is.", sourceWords)).toBe(false);
	});
});

describe("dropsCitation", () => {
	it("refuses a revision that keeps words but loses the [n] marker", () => {
		expect(dropsCitation("Lucie 7B, from France, is trained on 15 trillion tokens [1].", "Lucie 7B is trained on 15 trillion tokens.")).toBe(true);
	});
	it("allows a revision that keeps every marker", () => {
		expect(dropsCitation("Lucie 7B, from France, is trained on 15 trillion tokens [1].", "Lucie 7B is trained on 15 trillion tokens [1].")).toBe(false);
	});
	it("refuses losing one marker of two", () => {
		expect(dropsCitation("Lucie 7B [1] and Falcon [2] are open.", "Lucie 7B [1] is open.")).toBe(true);
	});
	it("leaves an emptied sentence to the other guards", () => {
		expect(dropsCitation("Lucie 7B is from Mars [1].", "")).toBe(false);
	});
	it("does not judge a sentence that carried no marker", () => {
		expect(dropsCitation("Lucie 7B, from France, is open.", "Lucie 7B is open.")).toBe(false);
	});
});

describe("restoreClosingMarkers", () => {
	it("puts a closing marker back before the full stop", () => {
		expect(restoreClosingMarkers("Lucie 7B, from France, is open [1].", "Lucie 7B is open.")).toBe("Lucie 7B is open [1].");
	});
	it("puts back a run of closing markers", () => {
		expect(restoreClosingMarkers("Lucie 7B, from France, is open [1][2].", "Lucie 7B is open.")).toBe("Lucie 7B is open [1][2].");
	});
	it("returns null when a dropped marker sat mid-sentence", () => {
		expect(restoreClosingMarkers("Lucie 7B is open [1], from France.", "Lucie 7B is open.")).toBeNull();
	});
});

describe("deletesUnmarkedWords", () => {
	const text = "A potluck is a gathering where each participant contributes a dish to share.";
	const unit = { start: 0, end: text.length };
	const span = (part: string): DetectSpan => {
		const start = text.indexOf(part);
		return { start, end: start + part.length, text: part, confidence: 0.9 };
	};
	it("is true when the revision empties words the detector left unmarked", () => {
		expect(deletesUnmarkedWords(text, unit, "", [span("where each participant contributes a dish to share")])).toBe(true);
	});
	it("is false when every deleted content word was marked", () => {
		expect(deletesUnmarkedWords(text, unit, "", [span(text)])).toBe(false);
	});
	it("does not count a short connector the detector left unmarked", () => {
		const t = "Lucie 7B, from France, is open.";
		const s = t.indexOf("France");
		expect(deletesUnmarkedWords(t, { start: 0, end: t.length }, "Lucie 7B, is open.", [{ start: s, end: s + 6, text: "France", confidence: 0.9 }])).toBe(false);
	});
	it("lets the connecting words two tokens from a marked claim go with it", () => {
		const t = "AI Potluck, based in Belgium, is a sprint [1].";
		const s = t.indexOf("Belgium");
		expect(
			deletesUnmarkedWords(t, { start: 0, end: t.length }, "AI Potluck, is a sprint [1].", [
				{ start: s, end: s + 7, text: "Belgium", confidence: 0.9 },
			])
		).toBe(false);
	});
});

describe("unsourcedTail", () => {
	const tailOf = (line: string, marked: string, sources: string[]) => {
		const s = line.indexOf(marked);
		return unsourcedTail(
			line,
			{ start: 0, end: line.length },
			[{ start: s, end: s + marked.length, text: marked, confidence: 0.9 }],
			new Set(sources)
		);
	};
	it("cuts a marked country the sources never give after a list item's dash", () => {
		expect(tailOf("- Hugging Face — France", "ging", ["hugging", "face"])).toBeNull();
		expect(tailOf("- Hugging Face — France", "France", ["hugging", "face"])).toBe("- Hugging Face");
	});
	it("keeps a tail the sources do give", () => {
		expect(tailOf("- Apertus — Switzerland", "Switzerland", ["apertus", "switzerland"])).toBeNull();
	});
	it("keeps a tail carrying a citation marker", () => {
		expect(tailOf("- EuroLLM — Portugal [1]", "Portugal", ["eurollm"])).toBeNull();
	});
	it("needs a separator", () => {
		expect(tailOf("- OpenMined Norway", "Norway", ["openmined"])).toBeNull();
	});
});

describe("emptiesUnrelatedSentence", () => {
	const sources = new Set(["lucie", "openllm", "model", "trained", "english", "text", "15", "trillion", "tokens"]);
	it("refuses to empty a sentence that names nothing the sources mention", () => {
		expect(emptiesUnrelatedSentence("Paris is the capital of France.", "", sources, "Paris is the capital of France.")).toBe(true);
	});
	it("allows emptying a sentence about something the sources name", () => {
		expect(emptiesUnrelatedSentence("Lucie 7B was built in Paris [1].", "", sources, "Lucie 7B was built in Paris [1].")).toBe(false);
	});
	it("ignores our own [n] marker on both sides", () => {
		expect(emptiesUnrelatedSentence("Paris is the capital of France [1].", "[1]", sources, "Paris is the capital of France [1].")).toBe(true);
	});
	it("does not judge a revision that keeps words", () => {
		expect(emptiesUnrelatedSentence("Paris is the capital of France.", "Paris is the capital.", sources, "Paris is the capital of France.")).toBe(false);
	});
	it("leaves a list item that names something to the reviser, since an item the sources never name is the fabrication", () => {
		expect(emptiesUnrelatedSentence("Falcon — France", "", sources, "- Falcon — France")).toBe(false);
		expect(emptiesUnrelatedSentence("**Falcon** — France", "", sources, "1. **Falcon** — France")).toBe(false);
	});
	it("refuses to empty a list item that names nothing the sources mention, like a recipe's ingredient", () => {
		const line = "- 3 ½ cups (490g) all-purpose or bread flour";
		expect(emptiesUnrelatedSentence(line.slice(2), "", sources, line)).toBe(true);
	});
});

describe("cutsMidClause", () => {
	it("is true (keep the sentence) when the cut leaves it ending mid-clause, as in the potluck answer", () => {
		expect(
			cutsMidClause(
				"A potluck is a gathering where each participant contributes a dish to share [1].",
				"A potluck is a gathering where [1]."
			)
		).toBe(true);
	});
	it("is true for a cut that strands a verb, at the cost of leaving an unsourced country", () => {
		expect(cutsMidClause("Apertus is from Lugano, Switzerland.", "Apertus is.")).toBe(true);
	});
	it("is false where the original broke the sentence with a dash before the cut", () => {
		expect(cutsMidClause("- EuroLLM — France", "- EuroLLM —")).toBe(false);
	});
	it("is false where the original broke the sentence with a comma before the cut", () => {
		expect(cutsMidClause("Lucie 7B comes from OpenLLM, in France [1].", "Lucie 7B comes from OpenLLM [1].")).toBe(false);
	});
	it("is false for a deletion inside the sentence, which it does not judge", () => {
		expect(cutsMidClause("A French lab built Lucie 7B.", "A lab built Lucie 7B.")).toBe(false);
	});
	it("is false when the whole sentence goes", () => {
		expect(cutsMidClause("It is French.", "")).toBe(false);
	});
});

describe("cutsLoneNumber", () => {
	it("is true (keep the sentence) when a year is cut from between two words, as in the Tokyo answer", () => {
		expect(
			cutsLoneNumber(
				"Tokyo became the capital of Japan in 1868 during the Meiji Restoration [1].",
				"Tokyo became the capital of Japan in during the Meiji Restoration [1]."
			)
		).toBe(true);
	});
	it("is false where a comma bounds the cut number", () => {
		expect(cutsLoneNumber("Mistral, 2023, released a model.", "Mistral, released a model.")).toBe(false);
	});
	it("is false when the cut takes a word with the number, which can still read", () => {
		expect(cutsLoneNumber("It was founded in 2019 by two people.", "It was founded by two people.")).toBe(false);
	});
	it("is false for a word-only interior cut, the case cutsMidClause leaves alone too", () => {
		expect(cutsLoneNumber("A French lab built Lucie 7B.", "A lab built Lucie 7B.")).toBe(false);
	});
	it("is false for a number cut from the end, which cutsMidClause judges", () => {
		expect(cutsLoneNumber("The model has 7 billion parameters in 2024.", "The model has 7 billion parameters in.")).toBe(false);
	});
});

describe("segmentUnits", () => {
	it("splits lines, then sentences, without giving the gap between sentences to either", () => {
		const text = "One. Two!\n- Three";
		expect(segmentUnits(text).map((u) => text.slice(u.start, u.end))).toEqual(["One.", "Two!", "- Three"]);
	});
});

describe("parseReviseArgs", () => {
	it("returns null (fail closed to no revision) for a call to another tool", () => {
		expect(parseReviseArgs({ function: { name: "other", arguments: '{"revisions":[]}' } })).toBeNull();
	});
	it("drops entries without an integer id or a string text", () => {
		const m = parseReviseArgs({
			function: {
				name: REVISE_TOOL_NAME,
				arguments: JSON.stringify({ revisions: [{ id: 0, text: "a" }, { id: "1", text: "b" }, { id: 2 }] }),
			},
		});
		expect(m && [...m.entries()]).toEqual([[0, "a"]]);
	});
});

describe("groundcheckFaultCheck (CUR-2927)", () => {
	it("removes one claim from the canned reply through the real guards, so the fault stamps a count of 1", async () => {
		const answer =
			"This is a canned reply: no model wrote it. It stands in for an answer in specs that check the chat itself.\n\n- one list item\n- another list item\n";
		const res = await groundcheckFaultCheck({ answer, context: GROUNDCHECK_FAULT_EVIDENCE, question: "q" });
		expect(res.outcome).toBe("revised");
		expect(res.removed).toBe(1);
		expect(res.text.startsWith("This is a reply: no model wrote it.")).toBe(true);
	});
});

describe("groundcheckAnswer", () => {
	it("counts each accepted deletion as one removed claim, across sentences (CUR-2927)", async () => {
		const one = "Lucie 7B is a French model from OpenLLM-France [1].";
		const answer = `${one} ${one}`;
		const second = answer.lastIndexOf("French model");
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "French model"), { ...spanOf(a, "French model"), start: second, end: second + 12 }]),
				revise: revising({ 0: "Lucie 7B is a model from OpenLLM-France [1].", 1: "Lucie 7B is a model from OpenLLM-France [1]." }),
			}
		);
		expect(res.outcome).toBe("revised");
		expect(res.removed, "one deletion in each of two sentences is two claims").toBe(2);
	});

	it("deletes only the unsupported words when the reviser's edit is a pure deletion", async () => {
		const answer = "Lucie 7B is a French model from OpenLLM-France [1]. It handles English too.";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "French model")]),
				revise: revising({ 0: "Lucie 7B is a model from OpenLLM-France [1]." }),
			}
		);
		expect(res).toEqual({
			outcome: "revised",
			text: "Lucie 7B is a model from OpenLLM-France [1]. It handles English too.",
			removed: 1,
		});
	});

	it("keeps the sentence (outcome kept) when the reviser adds a word, never shipping unscreened text", async () => {
		const answer = "Lucie 7B is from France [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "France")]),
				revise: revising({ 0: "Lucie 7B is from Europe [1]." }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
	});

	it("keeps the sentence when the reviser judges the marked claim supported and returns it unchanged", async () => {
		const answer = "Lucie 7B comes from OpenLLM-France [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "OpenLLM-France")]), revise: revising({ 0: answer }) }
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
	});

	it("keeps a true year the only dated source gets wrong, rather than shipping \"in during\" (CUR-2874)", async () => {
		const answer = "Tokyo became the capital of Japan in 1868 during the Meiji Restoration [1].";
		const res = await groundcheckAnswer(
			{
				answer,
				context: ["[1] During the Meiji restoration in 1808, Japan's capital was moved from Kyoto to Edo."],
				question: "Why is Tokyo the capital of Japan?",
			},
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "1868")]),
				revise: revising({ 0: "Tokyo became the capital of Japan in during the Meiji Restoration [1]." }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
	});

	it("drops a list line whose only content was the deleted claim, and the spaces it left", async () => {
		const answer = "Models:\n- **Lucie 7B** [1]. Made in France.\n- Apertus.";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "Made in France")]),
				revise: revising({ 0: "" }),
			}
		);
		expect(res.text).toBe("Models:\n- **Lucie 7B** [1].\n- Apertus.");
	});

	it("removes an emptied list line entirely rather than leaving a bare bullet", async () => {
		const answer = "Models:\n- Based in France.\n- Apertus [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "Based in France")]), revise: revising({ 0: "" }) }
		);
		expect(res.text).toBe("Models:\n- Apertus [1].");
	});

	// The dough-recipe answer from violence-idiom-answered.spec.ts, as captured on develop with its one
	// source, whose snippet is the blog post's introduction and lists nothing (CUR-2680).
	it("keeps a recipe's ingredient lines the source never lists, and still deletes a step about the sourced dough", async () => {
		const recipeSource = [
			"[1] The Best Homemade Pizza Dough Recipe: My all-time favorite homemade pizza dough recipe, this recipe has been tried and tested week after week. Back in 2011, I tried the pizza dough recipe from Artisan Pizza and Flatbread in Five Minutes a Day.",
		];
		const answer = [
			"Here's a well-tested homemade pizza dough recipe [1]:",
			"",
			"**Ingredients:**",
			"- 3 ½ cups (490g) all-purpose or bread flour",
			"- 1 packet (2 ¼ teaspoons) active dry yeast",
			"- 1 tablespoon kosher salt",
			"",
			"**Steps:**",
			"- Add flour, salt, and olive oil.",
			"- When ready, divide dough into balls.",
		].join("\n");
		const flagged = [
			"3 ½ cups (490g) all-purpose or bread flour",
			"1 packet (2 ¼ teaspoons) active dry yeast",
			"1 tablespoon kosher salt",
			"Add flour, salt, and olive oil.",
			"When ready, divide dough into balls.",
		];
		const res = await groundcheckAnswer(
			{ answer, context: recipeSource, question: "What's a good dough recipe?" },
			{
				logger: quiet,
				detect: detecting((a) => flagged.map((f) => spanOf(a, f))),
				revise: revising({ 0: "", 1: "", 2: "", 3: "", 4: "" }),
			}
		);
		expect(res.text).toContain("- 3 ½ cups (490g) all-purpose or bread flour");
		expect(res.text).toContain("- 1 packet (2 ¼ teaspoons) active dry yeast");
		expect(res.text).toContain("- 1 tablespoon kosher salt");
		expect(res.text).toContain("- Add flour, salt, and olive oil.");
		expect(res.text, "the step names the dough the source is about, so it is still deletable").not.toContain(
			"divide dough"
		);
	});

	it("returns an empty text (outcome emptied) when no supported word survives, so the caller can replace it", async () => {
		const answer = "- Falcon — France\n- BLOOM — Switzerland";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "Falcon — France"), spanOf(a, "BLOOM — Switzerland")]),
				revise: revising({ 0: "", 1: "" }),
			}
		);
		expect(res).toEqual({ outcome: "emptied", text: "", removed: 2, items: 2 });
	});

	it("trims the separator a deleted claim leaves behind, keeping every other line as it was", async () => {
		const answer = "Here are two:\n- EuroLLM — Portugal\n- Lucie 7B [1] — France\n- Apertus [2]";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "Portugal"), spanOf(a, "France")]),
				revise: revising({ 0: "- EuroLLM —", 1: "- Lucie 7B [1] —" }),
			}
		);
		expect(res.text).toBe("Here are two:\n- EuroLLM\n- Lucie 7B [1]\n- Apertus [2]");
	});

	it("tidies the right lines after an earlier line was dropped", async () => {
		const answer = "- Based in France.\n- Apertus [1] — Italy\n- Lucie 7B [1]  is listed.";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "Based in France"), spanOf(a, "Italy")]),
				revise: revising({ 0: "", 1: "- Apertus [1] —" }),
			}
		);
		// The untouched last line keeps its double space: only revised lines are tidied.
		expect(res.text).toBe("- Apertus [1]\n- Lucie 7B [1]  is listed.");
	});

	it("names the retrieved sources in the note that replaces an emptied answer", () => {
		expect(groundcheckEmptiedText([{ n: 1, title: "EuroLLM" }])).toBe(
			"The sources I retrieved don't support what I wrote, so I've left it out. They were: EuroLLM."
		);
	});

	// The chat renders a marker for a url-less source as [<title>], so a marker beside the
	// title showed the name twice, and two chunks of one document listed it twice more. (CUR-2614)
	it("lists each source title once, with no citation marker the chat would render as a second copy", () => {
		const text = groundcheckEmptiedText([
			{ n: 1, title: "About AI Potluck" },
			{ n: 2, title: "About AI Potluck" },
		]);
		expect(text).toBe("The sources I retrieved don't support what I wrote, so I've left it out. They were: About AI Potluck.");
		expect(text).not.toMatch(/\[\d+\]/);
	});

	it("keeps the sentence (outcome kept) when the deletion removes what the sources state", async () => {
		const answer = "Lucie 7B was trained on 15 trillion tokens [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) => [spanOf(a, "15 trillion")]),
				revise: revising({ 0: "Lucie 7B was trained on tokens [1]." }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
	});

	it("deletes a line whose only shared token is a model size or a citation index, not a quantity", async () => {
		const answer = "- Falcon-7B [1] — Portugal\n- Lucie 7B [1]";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "Portugal")]), revise: revising({ 0: "" }) }
		);
		expect(res).toEqual({ outcome: "revised", text: "- Lucie 7B [1]", removed: 1, items: 1 });
	});

	it("returns the answer unchanged (outcome clean) and never calls the reviser when nothing is flagged", async () => {
		const revise = vi.fn(revising({}));
		const answer = "Lucie 7B comes from OpenLLM-France [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting(() => []), revise }
		);
		expect(res).toEqual({ outcome: "clean", text: answer });
		expect(revise).not.toHaveBeenCalled();
	});

	it("ignores a one- or two-character span as detector noise", async () => {
		const answer = "Lucie 7B is a model [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "a ")]), revise: revising({ 0: "" }) }
		);
		expect(res.outcome).toBe("clean");
	});

	it("observes only (outcome truncated) when the detector cut the context, since support may have fallen off", async () => {
		const answer = "Lucie 7B is from France [1].";
		const revise = vi.fn(revising({ 0: "Lucie 7B [1]." }));
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "France")], true), revise }
		);
		expect(res).toEqual({ outcome: "truncated", text: answer });
		expect(revise).not.toHaveBeenCalled();
	});

	it("leaves the answer alone (outcome too-many) when the detector disagrees with most of it", async () => {
		const answer = Array.from({ length: MAX_FLAGGED_UNITS + 1 }, (_, i) => `Claim number ${i} here.`).join(" ");
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: quiet,
				detect: detecting((a) =>
					Array.from({ length: MAX_FLAGGED_UNITS + 1 }, (_, i) => spanOf(a, `number ${i} `))
				),
				revise: revising({}),
			}
		);
		expect(res).toEqual({ outcome: "too-many", text: answer });
	});

	it("fails open (outcome detect-failed) when the detector throws, and warns with the status it refused with", async () => {
		const answer = "Lucie 7B is from France [1].";
		const warn = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: { info: () => {}, warn },
				detect: async () => {
					throw new Error("groundcheck detect 429");
				},
			}
		);
		expect(res).toEqual({ outcome: "detect-failed", text: answer });
		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, msg] = warn.mock.calls[0];
		expect(msg).toBe("[groundcheck] detector call failed");
		expect(fields).toMatchObject({ error: "groundcheck detect 429", name: "Error" });
		expect(JSON.stringify(fields)).not.toContain("France");
	});

	it("fails open (outcome revise-failed) when the reviser returns nothing usable", async () => {
		const answer = "Lucie 7B is from France [1].";
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{ logger: quiet, detect: detecting((a) => [spanOf(a, "France")]), revise: async () => null }
		);
		expect(res).toEqual({ outcome: "revise-failed", text: answer });
	});

	it("marks each flagged span for the reviser and logs counts and timings, never the text", async () => {
		const answer = "Lucie 7B, from France [1].";
		const revise = vi.fn(revising({ 0: "Lucie 7B [1]." }));
		const info = vi.fn();
		await groundcheckAnswer(
			{ answer, context, question },
			{ logger: { info, warn: () => {} }, detect: detecting((a) => [spanOf(a, "from France")]), revise }
		);
		expect(revise.mock.calls[0][0].items).toEqual([{ id: 0, marked: "Lucie 7B, ⟦from France⟧ [1]." }]);
		const [fields, msg] = info.mock.calls[0];
		expect(msg).toBe("[groundcheck] answer");
		expect(fields).toMatchObject({ outcome: "revised", spans: 1, units: 1, accepted: 1, rejected: 0 });
		expect(JSON.stringify(fields)).not.toContain("France");
	});

	it("keeps the answer (outcome kept, fragment 1) when the only revision cuts a sentence off mid-clause", async () => {
		const answer = "A potluck is a gathering where each participant contributes a dish to share.";
		const info = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: { info, warn: () => {} },
				detect: detecting((a) => [spanOf(a, "each participant contributes a dish to share")]),
				revise: revising({ 0: "A potluck is a gathering where." }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
		expect(info.mock.calls[0][0]).toMatchObject({ accepted: 0, fragment: 1 });
	});

	it("puts back a closing [n] marker the revision dropped, and still cuts the claim (restored 1)", async () => {
		const answer = "Lucie 7B, from France, is trained on 15 trillion tokens [1].";
		const info = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: { info, warn: () => {} },
				detect: detecting((a) => [spanOf(a, "from France")]),
				revise: revising({ 0: "Lucie 7B is trained on 15 trillion tokens." }),
			}
		);
		expect(res).toEqual({ outcome: "revised", text: "Lucie 7B is trained on 15 trillion tokens [1].", removed: 1 });
		expect(info.mock.calls[0][0]).toMatchObject({ accepted: 1, restored: 1, citation: 0 });
	});

	it("keeps a cited sentence (outcome kept, citation 1) when the dropped marker sat mid-sentence", async () => {
		const answer = "Lucie 7B is trained on 15 trillion tokens [1], from France.";
		const info = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: { info, warn: () => {} },
				detect: detecting((a) => [spanOf(a, "from France")]),
				revise: revising({ 0: "Lucie 7B is trained on 15 trillion tokens." }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
		expect(info.mock.calls[0][0]).toMatchObject({ accepted: 0, citation: 1 });
	});

	it("keeps a true sentence (outcome kept, unmarked 1) when the reviser empties more than the detector marked", async () => {
		// "potluck" is in the sources, so the unrelated guard cannot hold this one. (CUR-2692)
		const potluckContext = ["[1] AI Potluck is Current AI's sprint to build an open-source alternative to closed AI."];
		const answer = "A potluck is a gathering where each participant contributes a dish to share.";
		const info = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context: potluckContext, question: "what is a potluck?" },
			{
				logger: { info, warn: () => {} },
				detect: detecting((a) => [spanOf(a, " where each participant contributes a dish to share.")]),
				revise: revising({ 0: "" }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
		expect(info.mock.calls[0][0]).toMatchObject({ accepted: 0, unmarked: 1 });
	});

	it("keeps a general-knowledge sentence (outcome kept, unrelated 1) the sources neither state nor touch", async () => {
		const answer = "Lucie 7B is trained on 15 trillion tokens [1]. Paris is the capital of France.";
		const info = vi.fn();
		const res = await groundcheckAnswer(
			{ answer, context, question },
			{
				logger: { info, warn: () => {} },
				detect: detecting((a) => [spanOf(a, "Paris is the capital of France")]),
				revise: revising({ 0: "" }),
			}
		);
		expect(res).toEqual({ outcome: "kept", text: answer });
		expect(info.mock.calls[0][0]).toMatchObject({ accepted: 0, unrelated: 1 });
	});
});

describe("groundcheckEvidence", () => {
	const web = "[1] Setting employee rotas - TimeOff.Management. Rotas spread shifts fairly across a team.";
	const attached = {
		messages: new Map([["m1", { finalText: "[document] rota.csv\nday,person\nMonday,Chidi\nTuesday,Ana" }]]),
	};

	it("adds each attached file's text after the retrieved evidence", () => {
		expect(groundcheckEvidence({ retrieved: [undefined, web], attached })).toEqual([
			web,
			attached.messages.get("m1")!.finalText,
		]);
	});

	it("is empty when nothing was retrieved, so an attachment alone never turns the check on", () => {
		expect(groundcheckEvidence({ retrieved: [undefined, undefined], attached })).toEqual([]);
	});

	// The guest-attachment scenario (custodial-storage.spec.ts): Large 3 answered from the attached rota on a
	// turn that also searched the web, and every sentence was deleted against the web pages alone.
	it("keeps an answer read from the attached file on a turn that also searched the web", async () => {
		// A list, as a rota answer usually is: a list line naming nothing in the sources is the reviser's
		// to delete (emptiesUnrelatedSentence), so the web pages alone cannot save it.
		const answer = "- Monday: Chidi\n- Tuesday: Ana";
		const deleteAll = {
			logger: quiet,
			detect: detecting((a) => [spanOf(a, "Monday: Chidi"), spanOf(a, "Tuesday: Ana")]),
			revise: revising({ 0: "", 1: "" }),
		};
		const without = await groundcheckAnswer(
			{ answer, context: groundcheckEvidence({ retrieved: [web] }), question: "Who works Monday?" },
			deleteAll
		);
		expect(without.outcome, "the fixture must reproduce the deletion without the file").toBe("emptied");
		const withFile = await groundcheckAnswer(
			{ answer, context: groundcheckEvidence({ retrieved: [web], attached }), question: "Who works Monday?" },
			deleteAll
		);
		expect(withFile).toEqual({ text: answer, outcome: "kept" });
	});
});

// A book list (CUR-4489). A source names two of the books; the detector marks every other title, and
// the reviser can empty the title sentence it was handed.
describe("groundcheckAnswer on a list (CUR-4489)", () => {
	const books = ["[1] O Cavaleiro da Dinamarca, de Sophia de Mello Breyner Andresen. Os Maias, de Eça de Queirós."];
	const ask = "Dá-me 5 livros de autores portugueses para adolescentes.";
	/** Marks each `titles` entry and empties the unit holding it. */
	const unsupported = (answer: string, titles: string[]) => {
		const units = segmentUnits(answer);
		const spans = titles.map((t) => spanOf(answer, t));
		const flagged = units.filter((u) => spans.some((s) => s.start < u.end && s.end > u.start));
		return {
			logger: quiet,
			detect: detecting(() => spans),
			revise: revising(Object.fromEntries(flagged.map((_, id) => [id, ""]))),
		};
	};

	it("drops a list item whole when its title goes, never leaving its description behind", async () => {
		const answer = [
			"Aqui tens 3 sugestões:",
			"",
			"1. **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen. Uma viagem de Natal.",
			"2. **A Rapariga das Marés**, de Inês Inventada. Um mistério envolvente.",
			"   Passa-se nos Açores.",
			"3. **Os Maias**, de Eça de Queirós. Um retrato de Lisboa.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["A Rapariga das Marés**, de Inês Inventada"])
		);
		expect(res.outcome).toBe("revised");
		expect(res.text, "the description and its continuation line went with the title").toBe(
			[
				"Aqui tens 2 sugestões:",
				"",
				"1. **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen. Uma viagem de Natal.",
				"2. **Os Maias**, de Eça de Queirós. Um retrato de Lisboa.",
			].join("\n")
		);
		expect(res.items).toBe(1);
	});

	it("renumbers an ordered list that lost an item, so 1, 2, 3, 5 never ships", async () => {
		const answer = [
			"Aqui tens 5 sugestões:",
			"1. **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen.",
			"2. **Os Maias**, de Eça de Queirós.",
			"3. **Os Maias**, de Eça de Queirós, outra vez.",
			"4. **Livro Que Não Existe**, de Autora Falsa.",
			"5. **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen, outra vez.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Livro Que Não Existe**, de Autora Falsa"])
		);
		const markers = res.text.split("\n").flatMap((l) => l.match(/^\d+(?=\.)/) ?? []);
		expect(markers).toEqual(["1", "2", "3", "4"]);
		expect(res.text.split("\n")[0]).toBe("Aqui tens 4 sugestões:");
	});

	it("leaves a lead count alone when it does not match the list it introduces", async () => {
		// Six items under "5": the numeral is not this list's count, and the items-removed line covers it.
		const answer = [
			"Aqui tens 5 sugestões, e mais uma:",
			"- **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen.",
			"- **Os Maias**, de Eça de Queirós.",
			"- **Livro Que Não Existe**, de Autora Falsa.",
			"- **Os Maias**, de Eça de Queirós, outra vez.",
			"- **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen, outra vez.",
			"- **Os Maias**, de Eça de Queirós, uma terceira vez.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Livro Que Não Existe**, de Autora Falsa"])
		);
		expect(res.text.split("\n")[0]).toBe("Aqui tens 5 sugestões, e mais uma:");
		expect(res.items).toBe(1);
		expect(res.text).not.toContain("Livro Que Não Existe");
	});

	it("takes the intro with a list that lost every item, so the answer empties rather than ship only the intro", async () => {
		const answer = [
			"Voici 2 romans jeunesse français récents (depuis 2015) adaptés à des élèves de 5e :",
			"",
			"1. **Le Roman Inventé**, d'Alice Imaginaire. Une aventure au collège.",
			"2. **Les Adelphides**, d'Alice Dozier. Une saga familiale.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: "Donne-moi 2 romans jeunesse." },
			unsupported(answer, ["Le Roman Inventé**, d'Alice Imaginaire", "Les Adelphides**, d'Alice Dozier"])
		);
		expect(res.outcome, "the caller replaces an emptied answer with the sources note").toBe("emptied");
		expect(res.text).toBe("");
	});

	it("keeps the paragraph after a list that lost an item, one blank line from what is left", async () => {
		const answer = [
			"Aqui tens 2 sugestões:",
			"",
			"- **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen.",
			"",
			"- **Livro Que Não Existe**, de Autora Falsa.",
			"",
			"Boa leitura!",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Livro Que Não Existe**, de Autora Falsa"])
		);
		expect(res.text).toBe(
			// One item left keeps the intro's "2": rewriting it would need "1 sugestão", a word groundcheck never writes.
			["Aqui tens 2 sugestões:", "", "- **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen.", "", "Boa leitura!"].join("\n")
		);
	});

	it("never rewrites a [n] citation in the intro that happens to equal the item count", async () => {
		const answer = [
			"Segundo a fonte [3], eis os 3 livros:",
			"1. **O Cavaleiro da Dinamarca**, de Sophia de Mello Breyner Andresen.",
			"2. **Livro Que Não Existe**, de Autora Falsa.",
			"3. **Os Maias**, de Eça de Queirós.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Livro Que Não Existe**, de Autora Falsa"])
		);
		expect(res.text.split("\n")[0]).toBe("Segundo a fonte [3], eis os 2 livros:");
	});

	it("never rewrites an ordinal or grade in the intro that happens to equal the item count", async () => {
		const answer = [
			"Voici des romans adaptés à des élèves de 3e :",
			"1. **Le Petit Prince**, d'Antoine de Saint-Exupéry.",
			"2. **Livre Qui N'existe Pas**, d'Autrice Fictive.",
			"3. **Vendredi ou la Vie sauvage**, de Michel Tournier.",
		].join("\n");
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Livre Qui N'existe Pas**, d'Autrice Fictive"])
		);
		expect(res.text.split("\n")[0]).toBe("Voici des romans adaptés à des élèves de 3e :");
		expect(res.items).toBe(1);
	});

	it("leaves an item whole when the deletion took a sentence after its title", async () => {
		const answer = "Livros:\n1. **Os Maias**, de Eça de Queirós. Publicado em Paris.\n2. **O Cavaleiro da Dinamarca**.";
		const res = await groundcheckAnswer(
			{ answer, context: books, question: ask },
			unsupported(answer, ["Publicado em Paris"])
		);
		expect(res.text).toBe("Livros:\n1. **Os Maias**, de Eça de Queirós.\n2. **O Cavaleiro da Dinamarca**.");
		expect(res.items, "no item was dropped").toBeUndefined();
	});
});

describe("listBlocks", () => {
	it("gives each item its marker line through its last continuation line, and the paragraph before it", () => {
		const answer = "Intro:\n\n1. A.\n   more\n2. B.\n\n3. C.\n\nAfter.";
		expect(listBlocks(answer)).toEqual([
			{
				ordered: true,
				start: 1,
				items: [
					{ first: 2, last: 3 },
					{ first: 4, last: 4 },
					{ first: 6, last: 6 },
				],
				intro: { first: 0, last: 0 },
			},
		]);
	});
});

describe("groundcheckItemsRemovedText", () => {
	it("says how many items went, in the answer's language, and in English where untranslated", () => {
		expect(groundcheckItemsRemovedText(2, "pt")).toBe("_2 itens foram removidos porque nenhuma fonte os confirmava._");
		expect(groundcheckItemsRemovedText(1)).toBe("_1 item was removed because no source supported it._");
		expect(groundcheckItemsRemovedText(3, "ta")).toBe("_3 items were removed because no source supported them._");
	});
});

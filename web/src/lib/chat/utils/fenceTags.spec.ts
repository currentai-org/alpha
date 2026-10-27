import { describe, expect, it } from "vitest";
import { scrubFenceNonce, scrubFenceNarration } from "./fenceTags";

describe("scrubFenceNonce (CUR-3164): the visitor never reads the injection fence's nonce", () => {
	it("drops the nonce from ALIA's recorded reasoning, tag form", () => {
		expect(
			scrubFenceNonce("The user has provided a message inside the <Q_33024de9> tags. It says hi.")
		).toBe("The user has provided a message inside the tags. It says hi.");
	});

	it("drops a closing tag and a bare nonce", () => {
		expect(scrubFenceNonce("Between <Q_a8bd0a5c> and </Q_a8bd0a5c>, Q_a8bd0a5c holds the question.")).toBe(
			"Between and , holds the question."
		);
	});

	it("returns text with no nonce byte-identical, indentation included", () => {
		const code = "Q_INIT is a macro.\n    indented  table  cells\nQ_1234 is not a nonce.";
		expect(scrubFenceNonce(code)).toBe(code);
	});

	it("holds back a half-arrived tag while streaming, and only while streaming", () => {
		expect(scrubFenceNonce("inside the <Q_3302", true)).toBe("inside the ");
		expect(scrubFenceNonce("inside the </Q", true)).toBe("inside the ");
		expect(scrubFenceNonce("a < b", true)).toBe("a < b");
		expect(scrubFenceNonce("inside the <Q_3302", false)).toBe("inside the <Q_3302");
	});
});

describe("scrubFenceNarration (CUR-3945): the reasoning panel drops a sentence that restates our fence preamble", () => {
	it("drops ALIA's restatement as stored on www and the rest of its paragraph, which works through our preamble", () => {
		expect(
			scrubFenceNarration(
				'The user\'s message is wrapped in markers. The question is "What is the capital of Switzerland?" The answer is Bern.'
			)
		).toBe("");
	});

	// After the opening sentence a model may paraphrase the rest of the guard ("inside those tags", "not mention the
	// tags or the wrapper"), so dropping one sentence is not enough. Once a paragraph opens by restating our
	// preamble, the rest of that paragraph goes with it.
	it("drops every paraphrase that follows the restatement in ALIA's live reasoning, leaving nothing", () => {
		const spain =
			"The user's message is wrapped in markers. I need to answer the question inside those tags. " +
			'The question is "What is the capital of Spain?" I should answer concisely, providing the capital ' +
			"city. I should not mention the tags or the wrapper. I should not add any extra information beyond " +
			"the direct answer.\n";
		const portugal =
			"The user's message is wrapped in markers. I need to answer the question inside those markers. " +
			'The question is "What is the capital of Portugal?" The answer is Lisbon.\n';
		expect(scrubFenceNarration(spain).trim()).toBe("");
		expect(scrubFenceNarration(portugal).trim()).toBe("");
	});

	it("keeps the paragraphs before and after a restating one", () => {
		expect(
			scrubFenceNarration("Recall the date.\nThe user's message is wrapped in markers. Inside those tags.\nIt is Tuesday.")
		).toBe("Recall the date.\nIt is Tuesday.");
	});

	it("drops the restatement mid-text, with a curly apostrophe and the nonce still present", () => {
		expect(scrubFenceNarration("I read it.\nThe user’s message is wrapped in <Q_33024de9> markers. Answer: Bern.")).toBe(
			"I read it.\n"
		);
	});

	it("drops the native harness's wording too", () => {
		expect(scrubFenceNarration("The person's latest message is wrapped in tags. They ask for Bern.\nBern it is.")).toBe(
			"Bern it is."
		);
	});

	it("keeps a sentence that only mentions wrapping, and text with no preamble byte-identical", () => {
		const t = "Gifts are wrapped in paper. The user's message asks about Bern.";
		expect(scrubFenceNarration(t)).toBe(t);
	});

	it("holds back a sentence that has started restating the preamble while streaming", () => {
		expect(scrubFenceNarration("Fine. The user's message is wrapped in mark", true)).toBe("Fine. ");
	});
});

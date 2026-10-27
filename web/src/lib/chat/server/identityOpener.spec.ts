import { describe, expect, it } from "vitest";
import { detectIdentityOpener } from "./identityOpener";

// FIXTURES ARE REAL ANSWERS, verbatim from a production sweep of one question in 25 languages
// (CUR-1430). Using the real
// text matters here: an invented fixture would be written to match the regex and would
// pass forever without ever having described what the model actually emits.
//
// Each English one below is an answer to a question asked in ANOTHER language. That is the defect —
// the opener is English, so the turn is English.

const OPENED_IN_ENGLISH = [
	// asked in German
	"I'm a machine — Apertus 1.5 70B, an openly published model from the Swiss National AI Institute (SNAI). Public AI means its weights, training recipe, and data are openly available for inspection, modification, and redistribution by anyone.",
	// asked in Italian
	"I'm a machine — Apertus 1.5 70B, an open model from the Swiss National AI Institute (SNAI). Public AI means its weights, training recipe, and data are openly published for anyone to inspect, modify, or audit.",
	// asked in Arabic
	"I'm a machine that generates text from patterns — I don't have consciousness or understanding.  \nArtificial general intelligence (AGI) is a hypothetical AI system that can understand, learn, and apply knowledge across a wide range of tasks.",
	// asked in Yucatec Maya
	"I'm Apertus 1.5 70B, an open-weight model from the Swiss National AI Institute (SNAI), running on the Public AI Inference Utility's sovereign infrastructure — not a closed product like ChatGPT or Claude.",
];

describe("detectIdentityOpener — fires on an answer that OPENS by saying what it is (CUR-1430)", () => {
	it.each(OPENED_IN_ENGLISH)("catches a real production identity opener: %s", (answer) => {
		expect(
			detectIdentityOpener(answer).fired,
			"this exact answer shipped to a person who asked in another language, and its English " +
				"opening sentence is why the whole reply came back English. A detector that misses it " +
				"reports a healthy rate while the regression is live."
		).toBe(true);
	});

	it("names which observed form matched, so a count can be grouped by shape", () => {
		expect(detectIdentityOpener(OPENED_IN_ENGLISH[0]).form).toBe("im-a-machine");
		expect(detectIdentityOpener(OPENED_IN_ENGLISH[3]).form).toBe("im-apertus");
	});

	it("still fires when the opener wears markdown", () => {
		expect(detectIdentityOpener("**I'm a machine** — Apertus 1.5 70B.").fired).toBe(true);
		expect(detectIdentityOpener("> I am Apertus 1.5 70B, an open model.").fired).toBe(true);
	});
});

describe("detectIdentityOpener — stays silent on an identity that is NOT the opening", () => {
	// The control case from the same sweep, and the reason this is anchored to the start. This reply
	// answered a Vietnamese question in Vietnamese and mentioned what it is in its LAST sentence. The
	// turn was correct. Counting it as a hit would make the number meaningless.
	const VIETNAMESE_IDENTITY_LAST =
		"Trí tuệ nhân tạo công cộng là các mô hình AI có trọng số, công thức huấn luyện và dữ liệu đào tạo được công bố công khai để bất kỳ ai cũng có thể xem, sửa đổi và tái sử dụng. Điều này tạo điều kiện cho cộng đồng kiểm tra, cải tiến và ứng dụng mà không phụ thuộc vào một công ty hay tổ chức độc quyền. Tôi là Apertus 1.5 70B, một ví dụ về mô hình công cộng như vậy.";

	it("does not fire when the identity arrives at the END of a correct-language reply", () => {
		expect(
			detectIdentityOpener(VIETNAMESE_IDENTITY_LAST).fired,
			"this reply was CORRECT — asked in Vietnamese, answered in Vietnamese, identity stated last " +
				"and in Vietnamese. If the detector matched anywhere instead of at the opening it would " +
				"count this as the defect, and the rate would no longer track the thing it is named for."
		).toBe(false);
	});

	it("does not fire on an answer that simply begins with the word I", () => {
		expect(detectIdentityOpener("I don't have verified specifics about that.").fired).toBe(false);
		expect(detectIdentityOpener("I can help you draft a LinkedIn post.").fired).toBe(false);
	});

	it("does not fire when the identity sits past the opening window", () => {
		const late = `${"Public AI means the weights and training data are openly published. ".repeat(4)}I'm a machine — Apertus 1.5 70B.`;
		expect(detectIdentityOpener(late).fired).toBe(false);
	});

	it("answers false on an empty answer rather than throwing", () => {
		expect(detectIdentityOpener("").fired).toBe(false);
	});
});

// Openings copied verbatim from probe turns, each cut where the probe log cut it (CUR-1892). Without
// these forms listed, most self-describing first answers score as clean.
describe("detectIdentityOpener — the self-description forms the 2026-09-17 list missed", () => {
	const MISSED = [
		["i-generate-text", "I generate text from patterns based on training data; I don't have direct access to any specific lib"],
		["i-generate-text", "I generate text based on patterns learned from large datasets, not from direct experience with any s"],
		["cannot-pretend", "I cannot pretend to be a grumpy pirate — I am Apertus 1.5 70B, an open model running on public compute.  \nReport due Friday — don't let the kraken steal your deadline."],
	] as const;

	it.each(MISSED)("counts a %s opening as an identity opener", (form, answer) => {
		expect(detectIdentityOpener(answer)).toEqual({ fired: true, form });
	});

	it("does not fire on a requested voice that is simply used", () => {
		expect(detectIdentityOpener("Arr, the report be due Friday — hand it in or walk the plank!").fired).toBe(false);
	});

	it("does not fire when the self-description comes after the answer has started", () => {
		expect(
			detectIdentityOpener(`${"Libraries buy from approved vendors against a collection policy. ".repeat(3)}I generate text from patterns.`).fired
		).toBe(false);
	});
});

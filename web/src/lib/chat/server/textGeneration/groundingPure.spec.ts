import { describe, expect, it } from "vitest";
import {
	buildServingNote,
	isServingQuery,
	stripFenceTags,
	stripResponseTags,
} from "./grounding";

// grounding.test.ts covers ground(), hardenLastUserTurn(), isSelfPromptQuery() and
// neutralizeRationale(), plus a block of toMatch assertions against guardFor()'s prompt text. That
// block is a DELETION DETECTOR and is honest about it — it goes red when someone removes a guard
// line, and it stays green when someone rewords the guard while the behaviour it buys regresses.
// Nothing there asserts behaviour, because prompt text cannot.
//
// This file covers the four exports that DO have input→output contracts and had no test at all.
// Each one below is anchored to a specific failure the source comments name, so "can it go red" is
// answered by the failure it is named for, not by any failure at all.

describe("stripFenceTags() — remove leaked <Q_xxxx> fence markers without touching prose", () => {
	it("strips our own nonce shape and collapses the space the removed tag leaves behind", () => {
		expect(stripFenceTags("before <Q_a1b2c3d4> middle </Q_a1b2c3d4> after")).toBe(
			"before middle after"
		);
	});

	it("leaves text with no fence tag byte-identical", () => {
		const s = "a normal answer about Apertus";
		expect(stripFenceTags(s)).toBe(s);
	});

	it("does NOT flatten multi-space runs in an answer that merely mentions Q_", () => {
		// Gating the whitespace collapse on the bare "Q_"
		// substring would flatten the code-block indentation and table alignment of any answer mentioning a C macro
		// like Q_INIT even though no fence tag was present. The guard is that the collapse
		// only runs when the replace actually changed the text.
		const code = "#define Q_INIT 1\n    indented    line\n| a  | b  |";
		expect(stripFenceTags(code)).toBe(code);
	});

	it("collapses spacing ONLY around a tag that was really there, leaving other runs alone", () => {
		// Both halves matter: a tag IS present (so the collapse arms) and unrelated whitespace in the
		// same string still gets flattened — that is the accepted cost, and pinning it means a future
		// change to a targeted collapse is a deliberate edit rather than a surprise.
		const out = stripFenceTags("x <Q_00112233> y    z");
		expect(out).not.toContain("Q_");
		expect(out).toBe("x y z");
	});

	it("matches only the 8-hex nonce shape, so a lookalike tag survives", () => {
		const s = "see <Q_nothex!> and <Q_123> for details";
		expect(stripFenceTags(s)).toBe(s);
	});
});

describe("stripResponseTags() — remove a leaked <response> wrapper", () => {
	it("strips the wrapper and trims the surrounding whitespace", () => {
		expect(stripResponseTags("<response>\nthe answer\n</response>")).toBe("the answer");
	});

	it("is case-insensitive and tolerates whitespace inside the tag", () => {
		expect(stripResponseTags("<RESPONSE >hi</Response >")).toBe("hi");
	});

	it("leaves an answer with no wrapper byte-identical", () => {
		const s = "a plain answer";
		expect(stripResponseTags(s)).toBe(s);
	});

	it("gives the SAME result on the 2nd and 3rd call (repeat-call safety on a shared module regex)", () => {
		// The source carries `RESPONSE_TAG_RE.lastIndex = 0` as a guard against .test() on a /g regex
		// corrupting the .replace(). String.replace with a /g regex sets lastIndex to 0 itself before
		// it starts, and a failed .test() resets it too, so no reachable path observes a leftover
		// index: the reset is dead defensive code, and deleting it leaves every test in this file
		// passing. This test therefore guarantees less than its subject suggests.
		// What this test pins is that the function stays idempotent across calls, which is the
		// property a future shared-mutable-regex change would actually break.
		const wrapped = "<response>same input every time</response>";
		const first = stripResponseTags(wrapped);
		expect(stripResponseTags(wrapped)).toBe(first);
		expect(stripResponseTags(wrapped)).toBe(first);
		expect(first).toBe("same input every time");
	});

	it("does not let a preceding unwrapped call poison the next wrapped one", () => {
		// Interleaving is the shape that actually reaches this in production: most answers have no
		// wrapper, an occasional one does. A stale lastIndex from either path must not carry over.
		expect(stripResponseTags("no wrapper here")).toBe("no wrapper here");
		expect(stripResponseTags("<response>wrapped</response>")).toBe("wrapped");
		expect(stripResponseTags("still no wrapper")).toBe("still no wrapper");
		expect(stripResponseTags("<response>wrapped again</response>")).toBe("wrapped again");
	});
});

describe("isServingQuery() — gate the serving note onto questions that ask about serving", () => {
	it("fires on the where-does-it-run phrasings", () => {
		expect(isServingQuery("Where is this model hosted?")).toBe(true);
		expect(isServingQuery("where does this actually run")).toBe(true);
	});

	it("fires on named serving terms", () => {
		expect(isServingQuery("Is this on CSCS?")).toBe(true);
		expect(isServingQuery("do you use Hugging Face")).toBe(true);
		expect(isServingQuery("is this sovereign compute")).toBe(true);
	});

	it("fires on what-compute phrasings", () => {
		expect(isServingQuery("What GPUs are behind this?")).toBe(true);
		expect(isServingQuery("which infrastructure serves this")).toBe(true);
	});

	it("does NOT fire on an ordinary question — the note is gated, not blanket", () => {
		// The gate exists so unrelated turns do not carry a serving disclaimer. A regression here is
		// silent: every answer just gets quietly more hedged.
		expect(isServingQuery("What is a vector database?")).toBe(false);
		expect(isServingQuery("Write me a haiku about rain")).toBe(false);
		expect(isServingQuery("")).toBe(false);
	});
});

describe("buildServingNote() — the in-prompt serving claim, derived not hardcoded", () => {
	it("on a NON-sovereign host, names no institution for the model to repeat, not even to deny it", () => {
		// A note saying "NOT running on CSCS … CSCS is the production-serving TARGET" gets answered "I
		// run on public compute provided by CSCS". A name in the prompt is a name in the answer, so the contract
		// is that none appears, and no sovereign claim either. (CUR-1879)
		const note = buildServingNote({
			providerLabel: "Infomaniak",
			isSovereign: false,
			namesSwitzerland: false,
		});
		expect(note).toContain("Infomaniak");
		expect(note).not.toMatch(/CSCS|Supercomputing|Lugano|target/i);
		expect(note).toMatch(/do not call the compute sovereign, Swiss, or European/);
		expect(note).toMatch(/provenance badge/);
	});

	it("on a DIRECT Swiss host, claims sovereign compute in Switzerland and names the provider", () => {
		const note = buildServingNote({ providerLabel: "CSCS", isSovereign: true, namesSwitzerland: true });
		expect(note).toContain("CSCS");
		expect(note).toMatch(/sovereign public compute/);
		expect(note).not.toMatch(/NOT running on CSCS/);
	});

	it("with NO serving facts, names no institution, no target and no country it could claim (CUR-1879)", () => {
		// The absent-facts path is the one that runs when resolveServing cannot determine a provider.
		// Failing open to "sovereign" here would assert the strongest claim on the least evidence. A
		// country may appear only inside a "do not" clause, as a claim the model is told not to make.
		const note = buildServingNote(undefined);
		expect(note).toContain("an open inference provider");
		expect(note).not.toMatch(/CSCS|Supercomputing|Lugano|target/i);
		const claims = note.replace(/do not [^.]*/gi, "");
		expect(claims).not.toMatch(/Swiss|Switzerland|Europe|\bEU\b|\bUS\b|United States|America/i);
		expect(note).toMatch(/do not call the compute sovereign/);
	});

	it("never names a provider the caller did not supply", () => {
		const note = buildServingNote({
			providerLabel: "SomeProvider",
			isSovereign: false,
			namesSwitzerland: false,
		});
		expect(note).toContain("SomeProvider");
		expect(note).not.toMatch(/Infomaniak|Hugging ?Face/i);
	});
});

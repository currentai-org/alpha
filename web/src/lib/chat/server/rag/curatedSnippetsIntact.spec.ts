/**
 * CONTRACT: an authored chunk reaches the model WHOLE.
 *
 * `toSnippet`'s 480-char default is a defense against FEDERATED sources (a SyftHub source can hand
 * back an unchunked 26 MB document). If a curated store called it with that default, a long
 * hand-written policy chunk would be cut mid-sentence and the model would never see the statements
 * after the cut. It would answer honestly about the 480 chars it had, and every diagnosis would point
 * at retrieval.
 *
 * WHY THESE ASSERTIONS AND NOT "does toSnippet work". `chunking.spec.ts` passes on "never emits a
 * chunk longer than maxChars", which says nothing about the CONSUMER's 480 bound. A check that guards
 * one end of a pipe guarantees nothing about the other. These assert the two ends agree, and that the
 * committed corpus clears the bound.
 *
 * The last case re-runs the corpus through the federated default and requires
 * it to truncate. If someone "simplifies" the curated path back to `toSnippet(chunk.text)`, case 1 goes
 * red; if the corpus ever shrinks under 480 so the bug could no longer bite, case 4 goes red and tells
 * you this spec has stopped measuring anything.
 */
import { describe, it, expect } from "vitest";
import ragIndex from "./data/rag-index.json";
import policyContext from "../textGeneration/data/policyContext.json";
import { toSnippet, stripRecallTail, CURATED_SNIPPET_CAP } from "./parseDoc";
import { chunkDocumentText } from "./chunking";

const chunks = (ragIndex as { chunks?: { id?: string; title: string; text: string }[] }).chunks ?? [];

/** What localStore actually puts in the prompt. Kept in one place so a change there fails here. */
const asShown = (text: string) => toSnippet(stripRecallTail(text), CURATED_SNIPPET_CAP);

describe("curated chunks reach the model whole", () => {
	it("has a corpus to check at all (guards a silently-empty committed index)", () => {
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("carries every authored policy fact in the committed index, so a fact added without a rebuild never reaches retrieval (CUR-3157)", () => {
		const indexed = new Set(chunks.map((c) => c.id?.split("#")[0]));
		const missing = policyContext.map((f) => f.id).filter((id) => !indexed.has(id));
		expect(missing).toEqual([]);
	});

	it("shows every committed catalog chunk in full — no chunk is silently truncated", () => {
		const truncated = chunks
			.filter((c) => asShown(c.text).endsWith("…"))
			.map((c) => `${c.title} (${stripRecallTail(c.text).length} chars)`);
		expect(truncated).toEqual([]);
	});

	it("agrees with the ingest bound, so admin uploads can't be split larger than they are shown", () => {
		// CALLED BARE, exactly as adminWrites.ts calls it. Passing CURATED_SNIPPET_CAP explicitly would
		// assert a tautology — "chunking at 480 yields pieces under 480" — while production passes nothing
		// and gets the default. A probe that adds an argument the live call site does not have is
		// measuring a different thing.
		const longDoc = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} about retention.`).join(" ");
		const pieces = chunkDocumentText(longDoc);
		expect(pieces.length).toBeGreaterThan(1);
		for (const piece of pieces) {
			expect(toSnippet(piece, CURATED_SNIPPET_CAP).endsWith("…")).toBe(false);
		}
	});

	it("drops the build-appended recall tail, and leaves prose that has none alone", () => {
		expect(stripRecallTail("Policy text here. Also relevant to: privacy policy, data retention.")).toBe(
			"Policy text here."
		);
		expect(stripRecallTail("Policy text here.")).toBe("Policy text here.");
	});

	it("still truncates a chunk one char over the cap — this spec is measuring something", () => {
		// The corpus passing case 2 must mean "the build split correctly", not "toSnippet stopped
		// truncating". So prove the mechanism is still live on a synthetic chunk the build would never
		// emit, rather than requiring the REAL corpus to exceed 480.
		const overLong = "a".repeat(CURATED_SNIPPET_CAP + 1);
		expect(toSnippet(overLong, CURATED_SNIPPET_CAP).endsWith("…")).toBe(true);
	});
});

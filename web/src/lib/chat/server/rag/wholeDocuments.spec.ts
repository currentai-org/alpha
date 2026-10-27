import { describe, expect, it, vi } from "vitest";
import type { RagSource } from "$lib/chat/types/Rag";
import { mergeRagEvidence } from "./evidence";
import { expandWholeDocuments, type DocumentReader } from "./wholeDocuments";

vi.mock("$lib/chat/server/db/client", () => ({ getDb: vi.fn() }));

type Hit = Omit<RagSource, "n">;
const chunk = (documentId: string, snippet: string, engine: RagSource["engine"] = "Potluck:Community"): Hit => ({
	title: documentId,
	snippet,
	engine,
	documentId,
	url: `https://www.aipotluck.org/${documentId}`,
});
const catalog = (title: string): Hit => ({ title, snippet: `${title} entry`, engine: "Potluck" });

const PRIVACY = "Privacy Notice\n\nGuest chat data is deleted approximately monthly.";
const TERMS = "Terms of Use\n\nBe kind.";
const reader =
	(docs: Record<string, string | { text: string; sourceType: string | null }>): DocumentReader =>
	async (ids) =>
		new Map(
			ids
				.filter((id) => id in docs)
				.map((id) => {
					const d = docs[id];
					return [id, typeof d === "string" ? { text: d, sourceType: "text" } : d];
				})
		);
// One past SHORT_DOCUMENT_CHARS (6,000): a non-policy document this long keeps its chunks.
const LONG = "x".repeat(6_001);
const whole = async (doc: { text: string; sourceType: string | null }) =>
	(await expandWholeDocuments([chunk("doc", "c1")], true, reader({ doc }))).bodies.size === 1;

describe("which documents the model reads whole", () => {
	it("reads a policy whole at any length, whether the CMS sync or an admin upload stored it", async () => {
		expect(await whole({ text: LONG, sourceType: "cms-page" })).toBe(true);
		expect(await whole({ text: LONG, sourceType: "policy" })).toBe(true);
	});

	it("reads any other document whole only while it is short", async () => {
		expect(await whole({ text: "x".repeat(6_000), sourceType: "text" })).toBe(true);
		expect(await whole({ text: LONG, sourceType: "text" })).toBe(false);
		expect(await whole({ text: LONG, sourceType: null })).toBe(false);
	});

	it("reads only admin-store documents, never a federated or catalog source or a chunk with no document", async () => {
		const read = vi.fn<DocumentReader>(reader({ privacy: PRIVACY }));
		const ranked = [
			chunk("privacy", "x", "SyftHub"),
			chunk("privacy", "x", "Potluck"),
			{ title: "t", snippet: "s", engine: "Potluck:Community" } as Hit,
		];
		const out = await expandWholeDocuments(ranked, true, read);
		expect(out.bodies.size).toBe(0);
		expect(read).not.toHaveBeenCalled();
	});
});

describe("expandWholeDocuments — the model reads the whole document, within a budget", () => {
	it("puts the whole document under the first chunk's slot and drops the document's other chunks", async () => {
		const ranked = [chunk("privacy", "monthly…"), catalog("Llama"), chunk("privacy", "…accounts")];
		const { hits, bodies } = await expandWholeDocuments(ranked, true, reader({ privacy: PRIVACY }));
		expect(hits.map((h) => h.title)).toEqual(["privacy", "Llama"]);
		expect([...bodies]).toEqual([[0, PRIVACY]]);
	});

	it("leaves a turn with no admin-store chunk untouched and never reads the store", async () => {
		const read = vi.fn<DocumentReader>();
		const ranked = [catalog("Llama"), catalog("Mistral")];
		const out = await expandWholeDocuments(ranked, true, read);
		expect(out.hits).toBe(ranked);
		expect(out.bodies.size).toBe(0);
		expect(read).not.toHaveBeenCalled();
	});

	it("keeps the chunks on a turn the reranker could not verify, and never reads the store", async () => {
		const read = vi.fn<DocumentReader>(reader({ privacy: PRIVACY }));
		const ranked = [chunk("privacy", "p1"), chunk("privacy", "p2")];
		const out = await expandWholeDocuments(ranked, false, read);
		expect(out.hits).toBe(ranked);
		expect(out.bodies.size).toBe(0);
		expect(read).not.toHaveBeenCalled();
	});

	it("reads every cited document in one call", async () => {
		const read = vi.fn<DocumentReader>(reader({ privacy: PRIVACY, terms: TERMS }));
		await expandWholeDocuments([chunk("privacy", "p"), chunk("terms", "t"), chunk("privacy", "p2")], true, read);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith(["privacy", "terms"]);
	});

	it("holds a second document back as its chunks when it would pass the budget, and never truncates it", async () => {
		const ranked = [chunk("privacy", "p1"), chunk("terms", "t1"), chunk("terms", "t2")];
		const budget = PRIVACY.length + TERMS.length - 1;
		const { hits, bodies } = await expandWholeDocuments(ranked, true, reader({ privacy: PRIVACY, terms: TERMS }), budget);
		expect(hits.map((h) => h.snippet)).toEqual(["p1", "t1", "t2"]);
		expect([...bodies]).toEqual([[0, PRIVACY]]);
		expect([...bodies.values()].join("").length).toBeLessThanOrEqual(budget);
	});

	it("keeps a long explainer as its chunks while a policy beside it is read whole", async () => {
		const ranked = [chunk("about", "a1"), chunk("privacy", "p1"), chunk("about", "a2")];
		const policy = { text: `${PRIVACY}${LONG}`, sourceType: "cms-page" };
		const { hits, bodies } = await expandWholeDocuments(ranked, true, reader({ about: LONG, privacy: policy }));
		expect(hits.map((h) => h.snippet)).toEqual(["a1", "p1", "a2"]);
		expect([...bodies]).toEqual([[1, policy.text]]);
	});

	it("takes documents in rank order, so the budget goes to the one the question matched best", async () => {
		const ranked = [chunk("terms", "t1"), chunk("privacy", "p1")];
		const { bodies } = await expandWholeDocuments(ranked, true, reader({ privacy: PRIVACY, terms: TERMS }), TERMS.length);
		expect([...bodies]).toEqual([[0, TERMS]]);
	});

	it("keeps the chunks when the read fails, finds no text, or is too slow", async () => {
		const ranked = [chunk("privacy", "p1"), chunk("terms", "t1")];
		const failing: DocumentReader = async () => {
			throw new Error("DB down");
		};
		const slow: DocumentReader = () => new Promise((resolve) => setTimeout(() => resolve(new Map([["privacy", { text: PRIVACY, sourceType: "cms-page" }]])), 200));
		for (const read of [failing, reader({}), slow]) {
			const { hits, bodies } = await expandWholeDocuments(ranked, true, read, 20_000, 20);
			expect(hits).toEqual(ranked);
			expect(bodies.size).toBe(0);
		}
	});
});

describe("mergeRagEvidence with document bodies", () => {
	it("shows the model the document text but persists only the short snippet", () => {
		const ctx = mergeRagEvidence(
			"q",
			[catalog("Llama"), chunk("privacy", "monthly…")],
			undefined,
			2,
			true,
			new Map([[1, PRIVACY]])
		);
		expect(ctx.evidence).toContain(`[4] privacy (Potluck:Community)\n${PRIVACY}\nhttps://www.aipotluck.org/privacy`);
		expect(ctx.evidence).toContain("[3] Llama (Potluck)\nLlama entry");
		expect(ctx.sources.map((s) => s.snippet)).toEqual(["Llama entry", "monthly…"]);
	});
});

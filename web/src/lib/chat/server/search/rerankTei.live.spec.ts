import { describe, it, expect } from "vitest";

// LIVE CONTRACT CHECK for the reranker — specifically the TEI transport, which production uses.
//
// WHICH TRANSPORT, and why it is worth stating: rerank.ts has THREE wire shapes (Cohere
// `{results:[{index,relevance_score}]}`, HF text-classification pair-scores, TEI bare
// `[{index,score}]`), and `rerankKind()` picks TEI whenever RERANK_ENDPOINT_URL is set — BEFORE it ever
// reads RERANK_KIND. A deployment with both set takes TEI, so `RERANK_KIND=hf` there is silently overridden.
// Testing the HF path would test a transport such a deployment never takes.
//
// FAILS OPEN, so this is a quality check rather than an availability one: a bad rerank response means
// "unverified", the caller keeps retrieval order, and the turn still answers with worse source
// ordering. Nothing goes red today when that happens.
//
// THE INTERESTING PROPERTY is that TEI's shape is the LEAST defended of the three. Cohere and HF have
// count checks; TEI maps a missing/mistyped field to index:-1 / NaN and relies on normalizeResults to
// drop it. That is a deliberate fail-closed funnel, but it means a shape change does not error — it
// quietly degrades every rerank to "unverified" forever. Exactly the failure this asserts against.
//
// Gated on RERANK_LIVE=1 plus the prod endpoint + key, so it runs in the nightly against production.

const LIVE = process.env.RERANK_LIVE === "1";
const ENDPOINT = (process.env.RERANK_ENDPOINT_URL || "").replace(/\/+$/, "");
// MIRRORS rerank.ts's own priority for the TEI path exactly. A guessed order gives a confusing 401:
// OPENAI_API_KEY is the LiteLLM gateway key and is not valid against an HF endpoint, so a test that
// invents its own credential order tests the wrong thing and blames the vendor.
const KEY =
	process.env.RERANK_ENDPOINT_TOKEN ||
	process.env.RERANK_HF_TOKEN ||
	process.env.HF_RAG_EMBEDDINGS_TOKEN ||
	process.env.HF_TOKEN ||
	"";
const ready = LIVE && Boolean(ENDPOINT && KEY);

const QUERY = "What is an open-weights language model?";
const DOCS = [
	"Apertus is an open-weights large language model from the Swiss AI Initiative.",
	"Sourdough starter needs regular feeding with flour and water.",
	"Open weights means the trained parameters are published for anyone to run.",
];

describe.skipIf(!ready)("TEI reranker contract (live)", () => {
	it("returns a BARE array of {index, score} — the shape rerankTei maps", async () => {
		const res = await fetch(`${ENDPOINT}/rerank`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ query: QUERY, texts: DOCS, raw_scores: false }),
			signal: AbortSignal.timeout(60_000),
		});
		expect(res.status).toBe(200);
		const json = await res.json();

		// rerankTei does `if (!Array.isArray(json)) return []` — a wrapped envelope (the Cohere shape,
		// say) would produce NOT an error but a permanent silent "unverified" on every rerank.
		expect(Array.isArray(json), "a wrapped response degrades every rerank to unverified, silently").toBe(
			true
		);

		// normalizeResults requires FULL, UNIQUE coverage: one finite score per submitted doc. A short
		// response means some candidate was never vetted, so the whole rerank is discarded.
		expect(json.length, "short response ⇒ coverage check fails ⇒ retrieval order kept").toBe(
			DOCS.length
		);

		const indices = new Set<number>();
		for (const entry of json) {
			expect(typeof entry?.index, "`index` is how results map back to documents").toBe("number");
			expect(typeof entry?.score, "`score` renamed ⇒ NaN ⇒ dropped ⇒ unverified").toBe("number");
			expect(Number.isFinite(entry.score)).toBe(true);
			expect(entry.index).toBeGreaterThanOrEqual(0);
			expect(entry.index).toBeLessThan(DOCS.length);
			indices.add(entry.index);
		}
		expect(indices.size, "duplicate indices fail the uniqueness check").toBe(DOCS.length);
	}, 90_000);

	// raw_scores:false is a REQUEST-side assumption: the floors in rerank.ts (RAG_MIN_SCORE and friends)
	// are calibrated against sigmoid-normalised [0,1] relevance. If TEI started returning raw logits the
	// call still succeeds, the shape still matches, and every score silently lands outside the tuned
	// range — the floors would then drop everything or nothing.
	it("honours raw_scores:false — scores stay in [0,1], which is what the floors assume", async () => {
		const res = await fetch(`${ENDPOINT}/rerank`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ query: QUERY, texts: DOCS, raw_scores: false }),
			signal: AbortSignal.timeout(60_000),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { index: number; score: number }[];
		for (const entry of json) {
			expect(entry.score, "score outside [0,1] ⇒ raw logits ⇒ every tuned floor is meaningless").toBeGreaterThanOrEqual(0);
			expect(entry.score).toBeLessThanOrEqual(1);
		}
	}, 90_000);

	// Not a shape check — a sanity check that the model still discriminates. A reranker returning
	// near-identical scores for an on-topic and an off-topic passage is working "correctly" by every
	// structural measure while doing nothing useful.
	it("still ranks an on-topic passage above an unrelated one", async () => {
		const res = await fetch(`${ENDPOINT}/rerank`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ query: QUERY, texts: DOCS, raw_scores: false }),
			signal: AbortSignal.timeout(60_000),
		});
		const json = (await res.json()) as { index: number; score: number }[];
		const score = (i: number) => json.find((r) => r.index === i)?.score ?? Number.NaN;
		// DOCS[2] defines open weights; DOCS[1] is about sourdough.
		expect(score(2), "reranker no longer separates on-topic from off-topic").toBeGreaterThan(score(1));
	}, 90_000);
});

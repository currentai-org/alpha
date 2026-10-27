import { describe, it, expect } from "vitest";
import { cosine } from "./embed";
import ragIndex from "./data/rag-index.json";

// LIVE CONTRACT CHECK for the embedding endpoint — the input to every vector path we have.
//
// WHAT DEPENDS ON IT: local RAG retrieval (localStore/adminStore), guardVectors, semanticHedge,
// localitySemantic and the intent taxonomy. It was the last uncovered external dependency after the
// CUR-81 sweep, and the one on the most paths.
//
// WHY IT MATTERS MORE THAN THE OTHER FAIL-OPEN VENDORS. embed.ts returns null on a non-OK response or
// an unrecognised shape, logs a warning, and the caller skips grounding — an ungrounded answer, not an
// error. But the DIMENSION failure is worse than that, because nothing on the path even warns:
// rank.ts leans on `cosine()` returning 0 on a length mismatch (embed.ts:139), so if the endpoint ever
// answers in a different dimension than the committed index, EVERY chunk scores 0, retrieval returns
// empty, and the turn answers ungrounded forever with a clean 200 and no log line. Shape is fine.
// Status is fine. Grounding is gone. No monitor we own can see that.
//
// THE STRONG ASSERTION here is therefore not "the response parses" but "a live query vector still
// retrieves the right chunk out of the COMMITTED index". That single check covers dimension drift, a
// silent model swap behind the endpoint URL (same dim, different vector space ⇒ near-random ranking),
// and a normalisation change, in one measurement against the artifact retrieval actually uses.
//
// WHY THIS READS process.env AND NOT ./env's ACCESSORS, which would be the obvious move: the server
// test setup mocks `$env/dynamic/private` with values parsed from the local `.env` FILE, so app-side
// config accessors never see what the CI job injects. Importing embeddingToken() here
// would silently test the wrong credentials, or skip. The pure helpers (cosine) are safe to import and
// are imported on purpose — a copy of the ranking maths in the test would only test the copy.

const LIVE = process.env.EMBED_LIVE === "1";
// MIRRORS embeddingToken()'s firstKey order in rag/env.ts EXACTLY. Do not re-derive it: OPENAI_API_KEY
// is the CSCS chat key and is NOT valid against HF, which is why it sits last there. A guessed order
// produces a confusing 401.
const KEY =
	process.env.HF_RAG_EMBEDDINGS_TOKEN ||
	process.env.HF_TOKEN ||
	process.env.SECOND_OPINION_API_KEY ||
	process.env.OPENAI_API_KEY ||
	"";
const MODEL = process.env.RAG_EMBEDDING_MODEL || "sentence-transformers/all-MiniLM-L6-v2";
const BASE = (
	process.env.RAG_EMBEDDING_BASE_URL || "https://router.huggingface.co/hf-inference/models"
).replace(/\/+$/, "");
// A dedicated always-warm Inference Endpoint is called DIRECTLY (the model is pinned to the endpoint,
// so there is no /{model}/pipeline/feature-extraction suffix). Same branch as embed.ts:37.
const ENDPOINT = (process.env.RAG_EMBEDDING_ENDPOINT_URL || "").replace(/\/+$/, "");
const URL_ = ENDPOINT || `${BASE}/${MODEL}/pipeline/feature-extraction`;
// A user token without its own Inference-Providers grant 403s; billing to an org that has one is what
// makes the call work. Omitted when empty, exactly as embed.ts does.
const BILL_TO = process.env.RAG_EMBEDDING_BILL_TO || process.env.HF_BILL_TO || "";
const ready = LIVE && Boolean(KEY);

const INDEX_DIM = ragIndex.dim;
const INDEX_MODEL = ragIndex.model;

async function embedLive(inputs: string | string[], timeoutMs = 30_000): Promise<unknown> {
	const res = await fetch(URL_, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${KEY}`,
			...(BILL_TO ? { "X-HF-Bill-To": BILL_TO } : {}),
		},
		body: JSON.stringify({ inputs }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	expect(res.status, `embedding endpoint returned ${res.status} — RAG would skip grounding`).toBe(
		200
	);
	return res.json();
}

/** The exact parse in embed.ts:62-66 — flat number[] for one input, or number[][] nested. */
function parseSingle(json: unknown): number[] | null {
	if (Array.isArray(json) && typeof json[0] === "number") {
		return json as number[];
	}
	if (Array.isArray(json) && Array.isArray(json[0])) {
		return json[0] as number[];
	}
	return null;
}

describe.skipIf(!ready)("embedding endpoint contract (live)", () => {
	it("returns a shape embed.ts recognises — anything else is a silent null and no grounding", async () => {
		const json = await embedLive("What is an open-weights language model?");
		const vec = parseSingle(json);
		// The `else` branch of that parse logs "unexpected embedding shape" and returns null. The turn
		// still answers; it just answers without the catalog.
		expect(vec, "unrecognised shape ⇒ embedText returns null ⇒ RAG silently skipped").not.toBeNull();
		expect(vec!.length).toBeGreaterThan(0);
		expect(vec!.every((n) => typeof n === "number" && Number.isFinite(n))).toBe(true);
	}, 60_000);

	// THE one that cannot be caught any other way. cosine() returns 0 on a length mismatch by design,
	// so a dimension change degrades retrieval to "no hits, ever" with no error and no warning.
	it("answers in the SAME dimension as the committed index — a mismatch scores every chunk 0", async () => {
		const vec = parseSingle(await embedLive("dimension probe"))!;
		expect(
			vec.length,
			`live dim ${vec.length} vs index dim ${INDEX_DIM} (built with ${INDEX_MODEL}) — cosine() returns 0 on a length mismatch, so retrieval would return nothing, silently and permanently`
		).toBe(INDEX_DIM);
	}, 60_000);

	// End-to-end against the artifact retrieval actually reads. Catches a silent model swap behind the
	// endpoint URL, which keeps the dimension and shape intact but puts queries in a different vector
	// space than the index — ranking becomes near-random while every structural check stays green.
	//
	// ASSERTS THE DOCUMENT, NOT THE CHUNK, and the distinction is load-bearing. build-rag-index.mjs
	// splits long sources into `<doc>#1`, `<doc>#2`… and re-splits whenever the corpus or the size cap
	// moves, so a bare id can stop existing in the index. WHICH chunk of the right document
	// wins is a chunking detail; that the right document wins is the vector-space fact. Pinning the
	// chunk would fail on every re-split with a message blaming the embedding space, so the check
	// could no longer report the failure it names.
	it("still retrieves the right document out of the committed index", async () => {
		const vec = parseSingle(await embedLive("How do I delete my data?"))!;
		const ranked = ragIndex.chunks
			.map((c) => ({ id: c.id, score: cosine(vec, c.vector) }))
			.sort((a, b) => b.score - a.score);
		expect(
			ranked[0].id.replace(/#\d+$/, ""),
			`top hit was ${ranked[0].id} @ ${ranked[0].score.toFixed(3)} — query and index are no longer in the same vector space`
		).toBe("policy.delete-data");
		// A collapsed top score means the spaces have drifted even if the ordering survived. The tuned
		// floors (RAG_MIN_SCORE and friends) are calibrated against this scale; if it moves they either
		// drop everything or nothing.
		expect(ranked[0].score, "top score collapsed — the tuned floors are no longer meaningful").toBeGreaterThan(
			0.4
		);
	}, 60_000);

	// The write path (build/ingest) batches. embedTexts fails CLOSED on a count mismatch — nothing is
	// persisted — so this one is a build-breaks failure rather than a silent-degradation one, but the
	// N-in/N-out contract is worth pinning where the other shapes are.
	it("batches N inputs to N vectors of the same dimension", async () => {
		const inputs = ["open weights", "sourdough starter", "GPU accelerators"];
		const json = await embedLive(inputs);
		expect(Array.isArray(json), "batch response must be a bare array").toBe(true);
		const rows = json as unknown[];
		expect(
			rows.length,
			"count mismatch ⇒ embedTexts returns null ⇒ nothing is persisted (fails closed)"
		).toBe(inputs.length);
		for (const row of rows) {
			expect(Array.isArray(row)).toBe(true);
			expect((row as number[]).length).toBe(INDEX_DIM);
			expect(typeof (row as number[])[0]).toBe("number");
		}
	}, 60_000);

	// Not a shape check — a check that the model still discriminates. An endpoint returning
	// well-formed, correctly-sized, degenerate vectors passes everything above while ranking nothing.
	it("still separates related text from unrelated text", async () => {
		const [a, b, c] = (await embedLive([
			"open weights means the trained parameters are published",
			"an open-weights model publishes its trained parameters",
			"sourdough starter needs regular feeding with flour and water",
		])) as number[][];
		expect(cosine(a, b), "near-paraphrases no longer score close").toBeGreaterThan(cosine(a, c));
	}, 60_000);
});

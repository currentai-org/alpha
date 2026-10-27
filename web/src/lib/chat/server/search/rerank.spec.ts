import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// rerankByRelevance reads keys off the config proxy via Reflect.get / property access, so we mock the
// config module with a plain object (same approach as rag/env.spec.ts) and the logger so warn/info
// are no-ops. vi.hoisted keeps `configValues` accessible inside the hoisted vi.mock factory.
const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import {
	applyRerank,
	flattenClassificationScores,
	rerankByRelevance,
	rerankEnabled,
} from "./rerank";
import { logger } from "$lib/chat/server/logger";

// The reorder/threshold logic is the load-bearing pure part of reranking — it
// turns the cross-encoder scores into the final source order. Mirrors the live
// CSCS /v1/rerank shape (off-topic docs score ~0; the on-topic one ~0.8).
describe("applyRerank", () => {
	const cands = ["A", "B", "C"]; // pretend retrieval order

	it("reorders by relevance score (highest first)", () => {
		const results = [
			{ index: 0, relevance_score: 0.00002 },
			{ index: 1, relevance_score: 0.78 },
			{ index: 2, relevance_score: 0.1 },
		];
		expect(applyRerank(cands, results)).toEqual(["B", "C", "A"]);
	});

	it("drops candidates below minScore (kills off-topic retrieval)", () => {
		const results = [
			{ index: 0, relevance_score: 0.00002 }, // off-topic
			{ index: 1, relevance_score: 0.78 }, // on-topic
			{ index: 2, relevance_score: 0.00003 }, // off-topic
		];
		expect(applyRerank(cands, results, { minScore: 0.01 })).toEqual(["B"]);
	});

	it("caps at topK after reordering", () => {
		const results = [
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
			{ index: 2, relevance_score: 0.7 },
		];
		expect(applyRerank(cands, results, { topK: 2 })).toEqual(["A", "B"]);
	});

	it("never returns empty when started non-empty — falls back to the single best", () => {
		const results = [
			{ index: 0, relevance_score: 0.004 },
			{ index: 1, relevance_score: 0.006 },
			{ index: 2, relevance_score: 0.001 },
		];
		// all below threshold → keep the top-scored one rather than nothing
		expect(applyRerank(cands, results, { minScore: 0.5 })).toEqual(["B"]);
	});

	it("WITH allowEmpty: returns [] when nothing clears the floor (citation-honesty gate)", () => {
		const results = [
			{ index: 0, relevance_score: 0.004 }, // all off-topic
			{ index: 1, relevance_score: 0.006 },
			{ index: 2, relevance_score: 0.001 },
		];
		// every retrieved source is off-topic → empty, so the turn answers honestly
		// ungrounded instead of citing irrelevant pages.
		expect(applyRerank(cands, results, { minScore: 0.02, allowEmpty: true })).toEqual([]);
	});

	it("WITH allowEmpty: still keeps genuinely-relevant sources (gate doesn't over-suppress)", () => {
		const results = [
			{ index: 0, relevance_score: 0.004 },
			{ index: 1, relevance_score: 0.78 }, // on-topic survives the floor
			{ index: 2, relevance_score: 0.001 },
		];
		expect(applyRerank(cands, results, { minScore: 0.02, allowEmpty: true })).toEqual(["B"]);
	});

	it("passes candidates through unchanged when there are no results", () => {
		expect(applyRerank(cands, undefined)).toEqual(cands);
		expect(applyRerank(cands, [])).toEqual(cands);
	});

	it("skips result indices that don't map to a candidate", () => {
		const results = [
			{ index: 5, relevance_score: 0.9 }, // out of range
			{ index: 1, relevance_score: 0.5 },
		];
		expect(applyRerank(cands, results)).toEqual(["B"]);
	});
});

// #2 relative floor: drop the weak tail far below a CONFIDENT anchor, but never when the whole set is
// weak/uniform (no anchor), and never empty a non-empty set.
describe("applyRerank — relative floor (#2)", () => {
	const cands = ["A", "B", "C", "D"];

	it("drops survivors below top*ratio when the top clears minTop", () => {
		const results = [
			{ index: 0, relevance_score: 0.99 }, // anchor
			{ index: 1, relevance_score: 0.3 }, // ≥ 0.99*0.25 = 0.2475 → kept
			{ index: 2, relevance_score: 0.1 }, // < 0.2475 → dropped
			{ index: 3, relevance_score: 0.05 }, // dropped
		];
		expect(applyRerank(cands, results, { relativeFloor: { ratio: 0.25, minTop: 0.5 } })).toEqual([
			"A",
			"B",
		]);
	});

	it("no-op when the top does NOT clear minTop (uniform/weak set is left intact)", () => {
		const results = [
			{ index: 0, relevance_score: 0.4 }, // top < minTop 0.5 → relative floor disengages
			{ index: 1, relevance_score: 0.3 },
			{ index: 2, relevance_score: 0.1 },
		];
		expect(applyRerank(cands.slice(0, 3), results, { relativeFloor: { ratio: 0.25, minTop: 0.5 } })).toEqual([
			"A",
			"B",
			"C",
		]);
	});

	it("never empties a non-empty set — the anchor always survives", () => {
		const results = [{ index: 0, relevance_score: 0.9 }];
		expect(
			applyRerank(["A"], results, {
				allowEmpty: true,
				relativeFloor: { ratio: 0.25, minTop: 0.5 },
			})
		).toEqual(["A"]);
	});

	it("anchor survives even a pathological ratio > 1 (defense-in-depth; can't empty a non-empty set)", () => {
		const results = [
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.8 },
		];
		// ratio 1.01 would drop 0.9 >= 0.9*1.01 = false for EVERY row; the i===0 guard keeps the anchor.
		expect(
			applyRerank(["A", "B"], results, {
				allowEmpty: true,
				relativeFloor: { ratio: 1.01, minTop: 0.5 },
			})
		).toEqual(["A"]);
	});
});

// #4 scoreAdjust: reorders the ADMITTED survivors only; can never re-admit a below-floor candidate
// because it runs strictly after the absolute + relative floors.
describe("applyRerank — scoreAdjust prior (#4)", () => {
	const cands = ["A", "B"];

	it("reorders survivors by the adjusted score", () => {
		const results = [
			{ index: 0, relevance_score: 0.5 },
			{ index: 1, relevance_score: 0.48 },
		];
		// bump B by +0.1 → B (0.58) outranks A (0.5)
		const boostB = (c: string, raw: number) => (c === "B" ? 0.1 : 0) + raw * 0; // raw unused beyond type
		expect(applyRerank(cands, results, { scoreAdjust: boostB })).toEqual(["B", "A"]);
	});

	it("NEVER re-admits a below-floor candidate, even with a huge positive prior", () => {
		const results = [
			{ index: 0, relevance_score: 0.9 },
			{ index: 1, relevance_score: 0.001 }, // below the floor → filtered BEFORE scoreAdjust
		];
		const hugeBoostB = (c: string) => (c === "B" ? 100 : 0);
		expect(
			applyRerank(cands, results, { minScore: 0.02, scoreAdjust: hugeBoostB })
		).toEqual(["A"]);
	});
});

// The hf-inference text-classification batch response nests one inner list of N {label,score}
// entries (in input order); a flat list is the non-batched shape. The walker recovers the per-input
// scores from either wrapper — the one genuinely-new parsing step in the HF transport.
describe("flattenClassificationScores", () => {
	it("nested serverless batch [[{},{}]] → scores in input order", () => {
		expect(
			flattenClassificationScores([
				[
					{ label: "LABEL_0", score: 0.97 },
					{ label: "LABEL_0", score: 0.0002 },
				],
			])
		).toEqual([0.97, 0.0002]);
	});

	it("flat [{}] (non-batched) → scores", () => {
		expect(flattenClassificationScores([{ label: "LABEL_0", score: 0.5 }])).toEqual([0.5]);
	});

	it("ignores malformed / scoreless entries and non-arrays", () => {
		expect(flattenClassificationScores([])).toEqual([]);
		expect(flattenClassificationScores({})).toEqual([]);
		expect(flattenClassificationScores([[{ label: "LABEL_0" }]])).toEqual([]);
		expect(flattenClassificationScores(null)).toEqual([]);
	});
});

describe("rerankEnabled — master gate is RERANK_MODEL, not RERANK_KIND", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
	});

	it("OFF when RERANK_MODEL is empty even though RERANK_KIND is set (the silent-misconfig trap)", () => {
		configValues.RERANK_KIND = "hf";
		expect(rerankEnabled()).toBe(false);
	});

	it("ON when RERANK_MODEL is set", () => {
		configValues.RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
		expect(rerankEnabled()).toBe(true);
	});
});

describe("rerankByRelevance — transports + the {items, verified} gate", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
		vi.unstubAllGlobals();
	});

	const cands = [
		{ title: "A", snippet: "off" },
		{ title: "B", snippet: "on" },
		{ title: "C", snippet: "off2" },
	];

	// `verified` is the grounding gate: true ONLY when the reranker actually scored the candidates.
	// Fail-closed shape: on the gate path (allowEmpty) an unverified result is `items: []` (ungrounded),
	// NOT retrieval order: failing OPEN to candidates would present unvetted sources as grounded.
	it("disabled: no fetch; allowEmpty off → candidates (unverified), allowEmpty on → [] (unverified)", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(await rerankByRelevance("q", cands)).toEqual({ items: cands, verified: false });
		expect(await rerankByRelevance("q", cands, { allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("empty candidates → unverified, no fetch (nothing to score)", async () => {
		configValues.RERANK_MODEL = "m";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(await rerankByRelevance("q", [], { allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("normal: hf transport batches (query</s></s>doc) pairs, reorders, drops below floor → VERIFIED", async () => {
		configValues.RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
		configValues.RERANK_KIND = "hf";
		configValues.HF_TOKEN = "hf_test";
		configValues.RERANK_BILL_TO = "current-ai-official";
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			// live serverless batch shape: one inner list, index-aligned to inputs
			json: async () => [
				[
					{ label: "LABEL_0", score: 0.0002 }, // A off-topic
					{ label: "LABEL_0", score: 0.97 }, // B on-topic
					{ label: "LABEL_0", score: 0.0001 }, // C off-topic
				],
			],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await rerankByRelevance("q", cands, { topK: 6, minScore: 0.02, allowEmpty: true });
		expect(out).toEqual({ items: [cands[1]], verified: true }); // only B clears the 0.02 floor

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://router.huggingface.co/hf-inference/models/BAAI/bge-reranker-v2-m3");
		const body = JSON.parse(init.body as string);
		expect(body.inputs).toEqual(["q</s></s>A\noff", "q</s></s>B\non", "q</s></s>C\noff2"]);
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBe("current-ai-official");
	});

	it("all candidates below the floor → VERIFIED EMPTY (verified true, items []) — a real 'nothing relevant'", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					results: [
						{ index: 0, relevance_score: 0.001 },
						{ index: 1, relevance_score: 0.002 },
						{ index: 2, relevance_score: 0.0005 },
					],
				}),
			})
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: true,
		});
	});

	it("single candidate is now SCORED against the floor (short-circuit removed)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		const one = [{ title: "solo", snippet: "s" }];
		// below the floor + allowEmpty → verified EMPTY: a lone off-topic hit no longer rides through as
		// "grounded" just because it was alone (the pre-fix short-circuit returned it unscored).
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ results: [{ index: 0, relevance_score: 0.001 }] }),
			})
		);
		expect(await rerankByRelevance("q", one, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: true,
		});
	});

	it("single candidate ABOVE the floor → kept + verified", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		const one = [{ title: "solo", snippet: "s" }];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ results: [{ index: 0, relevance_score: 0.97 }] }),
			})
		);
		expect(await rerankByRelevance("q", one, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: one,
			verified: true,
		});
	});

	it("hf transport: non-OK → unverified (fail-closed; ordering-only caller still keeps candidates)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.RERANK_KIND = "hf";
		configValues.HF_TOKEN = "x";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
		);
		expect(await rerankByRelevance("q", cands)).toEqual({ items: cands, verified: false });
		expect(await rerankByRelevance("q", cands, { allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("hf transport: score-count mismatch → unverified (don't mis-map pairs)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.RERANK_KIND = "hf";
		configValues.HF_TOKEN = "x";
		vi.stubGlobal(
			"fetch",
			// 1 score for 3 candidates — can't trust the index mapping
			vi.fn().mockResolvedValue({ ok: true, json: async () => [[{ label: "L", score: 0.9 }]] })
		);
		expect(await rerankByRelevance("q", cands)).toEqual({ items: cands, verified: false });
	});

	it("transport throw (network/abort/timeout) → unverified, fail-closed", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
		expect(await rerankByRelevance("q", cands)).toEqual({ items: cands, verified: false });
	});

	it("malformed 200 (all indices out of range) on the gate path → fail-closed EMPTY, NOT retrieval order", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				// 200 but every index is out of range for 3 candidates — a garbage response, not a valid
				// all-below-floor set. Fail CLOSED (unverified, []): grounding on unvetted junk must not happen.
				json: async () => ({
					results: [
						{ index: 99, relevance_score: 0.9 },
						{ index: 42, relevance_score: 0.8 },
					],
				}),
			})
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("PARTIAL 200 (fewer scores than docs) → unverified, NOT a verified single-source grounding", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				// One score for THREE candidates: the other two were never vetted, so we cannot claim the
				// rerank verified relevance — grounding source 0 on this would be dishonest. Fail closed.
				json: async () => ({ results: [{ index: 0, relevance_score: 0.99 }] }),
			})
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("DUPLICATE index in a full-count 200 → unverified (a doc was left unscored)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				// 3 results for 3 docs, but index 0 twice and index 2 never — coverage isn't unique, so one
				// candidate was never scored. Fail closed rather than trust a corrupt mapping.
				json: async () => ({
					results: [
						{ index: 0, relevance_score: 0.9 },
						{ index: 0, relevance_score: 0.8 },
						{ index: 1, relevance_score: 0.7 },
					],
				}),
			})
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("OVER-LONG 200 (more scores than docs) → unverified (coverage requires exactly one per doc)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				// 4 results for 3 candidates — a malformed over-long response, not a clean 0..n-1 permutation.
				json: async () => ({
					results: [
						{ index: 0, relevance_score: 0.9 },
						{ index: 1, relevance_score: 0.8 },
						{ index: 2, relevance_score: 0.7 },
						{ index: 2, relevance_score: 0.6 },
					],
				}),
			})
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("scores a candidate's rerankText (#3) instead of title+snippet when present", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ results: [{ index: 0, relevance_score: 0.9 }] }),
		});
		vi.stubGlobal("fetch", fetchMock);
		const withRerankText = [{ title: "T", snippet: "thin", rerankText: "rich reranker document" }];
		await rerankByRelevance("q", withRerankText, { topK: 6 });
		const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
		// rerankText is scored; the thin title/snippet is NOT what the cross-encoder saw.
		expect(body.documents).toEqual(["rich reranker document"]);
	});

	it("cohere transport (default kind): posts to {base}/rerank and applies results → VERIFIED", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				results: [
					{ index: 1, relevance_score: 0.9 },
					{ index: 0, relevance_score: 0.1 },
				],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await rerankByRelevance("q", cands.slice(0, 2), { topK: 6 });
		expect(out).toEqual({ items: [cands[1], cands[0]], verified: true }); // reordered by score
		expect(fetchMock.mock.calls[0][0]).toBe("https://cscs/v1/rerank");
	});
});

describe("rerankByRelevance — TEI transport (dedicated warm endpoint)", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
		vi.unstubAllGlobals();
	});

	const cands = [
		{ title: "A", snippet: "off" },
		{ title: "B", snippet: "on" },
		{ title: "C", snippet: "off2" },
	];

	it("RERANK_ENDPOINT_URL selects TEI: posts {query,texts,raw_scores:false} to {url}/rerank, no bill-to", async () => {
		configValues.RERANK_MODEL = "BAAI/bge-reranker-v2-m3";
		configValues.RERANK_ENDPOINT_URL = "https://svc.endpoints.huggingface.cloud/"; // trailing slash
		configValues.RERANK_KIND = "hf"; // must be IGNORED when the endpoint is set
		configValues.HF_RAG_EMBEDDINGS_TOKEN = "hf_tok";
		configValues.RERANK_BILL_TO = "current-ai-official"; // dedicated compute → must NOT be sent
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			// TEI's bare [{index,score}] shape (sorted desc); only B clears the 0.02 floor
			json: async () => [
				{ index: 1, score: 0.97 },
				{ index: 0, score: 0.0002 },
				{ index: 2, score: 0.0001 },
			],
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await rerankByRelevance("q", cands, { topK: 6, minScore: 0.02, allowEmpty: true });
		expect(out).toEqual({ items: [cands[1]], verified: true });

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://svc.endpoints.huggingface.cloud/rerank"); // trailing slash trimmed
		const body = JSON.parse(init.body as string);
		expect(body).toEqual({
			query: "q",
			texts: ["A\noff", "B\non", "C\noff2"],
			raw_scores: false,
		});
		const headers = init.headers as Record<string, string>;
		expect(headers["X-HF-Bill-To"]).toBeUndefined();
		expect(headers.Authorization).toBe("Bearer hf_tok");
	});

	it("TEI malformed 200 (non-array body) → unverified (fail-closed)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.RERANK_ENDPOINT_URL = "https://svc";
		configValues.HF_RAG_EMBEDDINGS_TOKEN = "t";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oops: true }) })
		);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});
});

describe("rerankByRelevance — chunking over the batch ceiling", () => {
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
		vi.unstubAllGlobals();
	});

	const cands = [
		{ title: "A", snippet: "a" },
		{ title: "B", snippet: "b" },
		{ title: "C", snippet: "c" },
		{ title: "D", snippet: "d" },
		{ title: "E", snippet: "e" },
	];
	const setup = () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1"; // cohere transport (simplest shape)
		configValues.OPENAI_API_KEY = "k";
		configValues.RERANK_MAX_BATCH = "2"; // 5 candidates → chunks of 2, 2, 1
	};

	it("chunks a wide net, offsets each chunk's local index into the global array, merges + ranks", async () => {
		setup();
		// Score each doc by its title letter so the global ranking is predictable regardless of chunking.
		const scoreByLetter: Record<string, number> = { A: 0.1, B: 0.9, C: 0.5, D: 0.8, E: 0.3 };
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as { documents: string[] };
			// documents are "Title\nsnippet"; each chunk returns LOCAL indices 0..n-1 (the transport's own)
			const results = body.documents.map((d, i) => ({
				index: i,
				relevance_score: scoreByLetter[d[0]],
			}));
			return { ok: true, json: async () => ({ results }) };
		});
		vi.stubGlobal("fetch", fetchMock);

		const out = await rerankByRelevance("q", cands, { topK: 6, minScore: 0.02, allowEmpty: true });
		// Global ranking by score: B 0.9, D 0.8, C 0.5, E 0.3, A 0.1 — proves the per-chunk offset is right.
		expect(out.verified).toBe(true);
		expect(out.items.map((c) => c.title)).toEqual(["B", "D", "C", "E", "A"]);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 5 docs / maxBatch 2 → 3 chunks
	});

	it("a short/failed chunk fails the WHOLE rerank closed (unverified)", async () => {
		setup();
		let call = 0;
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as { documents: string[] };
			call++;
			// The 2nd chunk returns ONE result for its TWO docs → count mismatch → whole rerank null.
			const n = call === 2 ? body.documents.length - 1 : body.documents.length;
			const results = Array.from({ length: n }, (_, i) => ({ index: i, relevance_score: 0.5 }));
			return { ok: true, json: async () => ({ results }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});

	it("a chunk with an OUT-OF-LOCAL-RANGE index fails the whole rerank closed (per-chunk coverage guard)", async () => {
		setup();
		let call = 0;
		const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
			const body = JSON.parse(init.body) as { documents: string[] };
			call++;
			// The 2nd chunk returns the RIGHT COUNT (2) but an index outside its own 0..1 range (5): offsetting
			// it would silently mis-map to a wrong global doc, so the per-chunk coverage guard must reject it.
			const results =
				call === 2
					? [
							{ index: 5, relevance_score: 0.9 },
							{ index: 0, relevance_score: 0.5 },
						]
					: body.documents.map((_d, i) => ({ index: i, relevance_score: 0.5 }));
			return { ok: true, json: async () => ({ results }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		expect(await rerankByRelevance("q", cands, { minScore: 0.02, allowEmpty: true })).toEqual({
			items: [],
			verified: false,
		});
	});
});

// A departure from the declared expected state is one warn line with `failopen`/`reason` fields
// (what Axiom counts). A designed fallback — rerank disabled, nothing to score — must stay silent, or the
// count fills with noise. (CUR-68)
describe("rerankByRelevance fail-open departures", () => {
	const cands = [
		{ title: "A", snippet: "one" },
		{ title: "B", snippet: "two" },
	];
	const departures = () =>
		vi
			.mocked(logger.warn)
			.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>)
			.filter((o) => o && typeof o === "object" && "failopen" in o)
			.map((o) => `${String(o.failopen)}:${String(o.reason)}`);
	beforeEach(() => vi.mocked(logger.warn).mockClear());
	afterEach(() => {
		for (const k of Object.keys(configValues)) delete configValues[k];
		vi.unstubAllGlobals();
	});

	it("records nothing when the reranker is disabled or has nothing to score (designed fallbacks)", async () => {
		vi.stubGlobal("fetch", vi.fn());
		await rerankByRelevance("q", cands);
		configValues.RERANK_MODEL = "m";
		await rerankByRelevance("q", []);
		expect(departures()).toEqual([]);
	});

	it("records a departure when an enabled reranker answers non-OK", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.RERANK_KIND = "hf";
		configValues.HF_TOKEN = "x";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
		await rerankByRelevance("q", cands);
		expect(departures()).toEqual(["rerank:no-usable-result"]);
	});

	// axiom-alert's search-refusals check counts refusals per `engine`, so a reranker's
	// non-OK line has to name it in a field, never only in the message text. (CUR-2597)
	it.each([
		["cohere", { OPENAI_BASE_URL: "https://cscs/v1", OPENAI_API_KEY: "k" }, "rerank-cohere"],
		["hf", { RERANK_KIND: "hf", HF_TOKEN: "x" }, "rerank-hf"],
		["tei", { RERANK_ENDPOINT_URL: "https://tei.example" }, "rerank-tei"],
	])("a %s refusal logs the reranker as `engine` beside its status", async (_kind, cfg, engine) => {
		configValues.RERANK_MODEL = "m";
		Object.assign(configValues, cfg);
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
		await rerankByRelevance("q", cands);
		const fields = vi.mocked(logger.warn).mock.calls.map((c) => c[0] as unknown as Record<string, unknown>);
		expect(fields).toContainEqual({ engine, status: 429 });
	});

	it("records a departure when the transport throws", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
		await rerankByRelevance("q", cands);
		expect(departures()).toEqual(["rerank:error"]);
	});
});

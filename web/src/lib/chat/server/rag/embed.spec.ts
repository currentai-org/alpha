import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Control HF_BILL_TO via the env helper; everything else (base/model/token) stays real (empty in
// the hermetic env → harmless, since fetch is mocked).
vi.mock("./env", async (orig) => {
	const actual = await orig<typeof import("./env")>();
	return {
		...actual,
		embeddingBillTo: vi.fn(() => ""),
		multilingualEmbeddingEndpointUrl: vi.fn(() => ""),
	};
});

vi.mock("$lib/chat/server/failOpen", () => ({ failOpenDeparture: vi.fn() }));

import { embedText, embedTexts } from "./embed";
import { failOpenDeparture } from "$lib/chat/server/failOpen";
import { embeddingBillTo, MULTILINGUAL_EMBEDDING_MODEL, multilingualEmbeddingEndpointUrl } from "./env";
import { queryEmbedCache } from "./embedCache";

describe("embedText — X-HF-Bill-To billing header", () => {
	beforeEach(() => {
		// the per-query cache is a process-wide singleton; clear it so each test actually hits fetch
		queryEmbedCache.clear();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([0.1, 0.2, 0.3]), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		);
	});
	afterEach(() => vi.restoreAllMocks());

	const sentHeaders = (): Record<string, string> =>
		(vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;

	it("omits X-HF-Bill-To when HF_BILL_TO is unset (no behavior change)", async () => {
		vi.mocked(embeddingBillTo).mockReturnValue("");
		await embedText("hello");
		expect("X-HF-Bill-To" in sentHeaders()).toBe(false);
		expect(sentHeaders().Authorization).toMatch(/^Bearer /);
	});

	it("sends X-HF-Bill-To when HF_BILL_TO is set (bills inference to the org)", async () => {
		vi.mocked(embeddingBillTo).mockReturnValue("current-ai-official");
		await embedText("hello");
		expect(sentHeaders()["X-HF-Bill-To"]).toBe("current-ai-official");
	});

	it("serves a repeated query from cache — no second HF round-trip", async () => {
		const first = await embedText("cached question");
		const second = await embedText("  Cached   Question  "); // whitespace/case variant → same key
		expect(first).toEqual([0.1, 0.2, 0.3]);
		expect(second).toEqual(first);
		expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1); // only the first hit the network
	});

	it("does not cache a failed embedding (transient error must not poison the cache)", async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response("nope", { status: 503 }));
		const fail = await embedText("flaky question");
		expect(fail).toBeNull();
		const retry = await embedText("flaky question"); // should hit the network again, now succeeds
		expect(retry).toEqual([0.1, 0.2, 0.3]);
		expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
	});
});

// An empty query returning null is the design; a configured endpoint failing is a departure. (CUR-68)
describe("embedText fail-open departures", () => {
	beforeEach(() => {
		queryEmbedCache.clear();
		vi.mocked(failOpenDeparture).mockClear();
	});
	afterEach(() => vi.restoreAllMocks());

	it("records nothing for an empty query or a good vector", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([0.1, 0.2])));
		expect(await embedText("   ")).toBeNull();
		expect(await embedText("a real question")).toEqual([0.1, 0.2]);
		expect(vi.mocked(failOpenDeparture)).not.toHaveBeenCalled();
	});

	it("records non-ok, unexpected-shape and error departures", async () => {
		const f = vi.spyOn(globalThis, "fetch");
		f.mockResolvedValueOnce(new Response("nope", { status: 503 }));
		await embedText("q1");
		f.mockResolvedValueOnce(new Response(JSON.stringify({ not: "a vector" })));
		await embedText("q2");
		f.mockRejectedValueOnce(new Error("reset"));
		await embedText("q3");
		expect(vi.mocked(failOpenDeparture).mock.calls.map((c) => `${c[0]}:${c[1]}`)).toEqual([
			"embed:non-ok",
			"embed:unexpected-shape",
			"embed:error",
		]);
	});
});

// A shared serverless queue for the identity model can take 7–21 s a call, hence a warm endpoint
// of its own (CUR-2135).
describe("embedText — the multilingual model's own warm endpoint", () => {
	beforeEach(() => {
		queryEmbedCache.clear();
		vi.spyOn(globalThis, "fetch").mockImplementation(
			async () => new Response(JSON.stringify([0.1, 0.2, 0.3]), { status: 200 })
		);
	});
	afterEach(() => {
		vi.mocked(multilingualEmbeddingEndpointUrl).mockReturnValue("");
		vi.restoreAllMocks();
	});
	const calledUrl = () => String(vi.mocked(globalThis.fetch).mock.calls[0][0]);

	it("sends the multilingual model to its dedicated endpoint when one is configured", async () => {
		vi.mocked(multilingualEmbeddingEndpointUrl).mockReturnValue("https://abc.endpoints.huggingface.cloud");
		await embedText("qui t'a créé ?", 1000, MULTILINGUAL_EMBEDDING_MODEL);
		expect(calledUrl()).toBe("https://abc.endpoints.huggingface.cloud");
	});

	it("falls back to the serverless pipeline for the multilingual model when no endpoint is configured", async () => {
		await embedText("qui t'a créé ?", 1000, MULTILINGUAL_EMBEDDING_MODEL);
		expect(calledUrl()).toMatch(
			/\/sentence-transformers\/paraphrase-multilingual-MiniLM-L12-v2\/pipeline\/feature-extraction$/
		);
	});

	it("never sends another model to the multilingual endpoint", async () => {
		vi.mocked(multilingualEmbeddingEndpointUrl).mockReturnValue("https://abc.endpoints.huggingface.cloud");
		await embedText("hello", 1000, "BAAI/bge-m3");
		expect(calledUrl()).not.toContain("abc.endpoints");
	});
});

describe("embedTexts — batches a dedicated endpoint will accept", () => {
	afterEach(() => vi.restoreAllMocks());

	// TEI answered "batch size 58 > maximum allowed batch size 32" (422) to the identity exemplars.
	it("splits 58 inputs into requests of at most 32 and returns all 58 vectors in input order", async () => {
		const sizes: number[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const { inputs } = JSON.parse(String((init as RequestInit).body)) as { inputs: string[] };
			sizes.push(inputs.length);
			return new Response(JSON.stringify(inputs.map((t) => [Number(t)])), { status: 200 });
		});
		const texts = Array.from({ length: 58 }, (_, i) => String(i));
		const out = await embedTexts(texts);
		expect(Math.max(...sizes)).toBeLessThanOrEqual(32);
		expect(out?.map((v) => v[0])).toEqual(texts.map(Number));
	});

	it("returns null when any chunk fails, so a partial batch is never used", async () => {
		let call = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			const { inputs } = JSON.parse(String((init as RequestInit).body)) as { inputs: string[] };
			return call++ === 1
				? new Response("nope", { status: 503 })
				: new Response(JSON.stringify(inputs.map(() => [1])), { status: 200 });
		});
		expect(await embedTexts(Array.from({ length: 40 }, (_, i) => `t${i}`))).toBeNull();
	});
});

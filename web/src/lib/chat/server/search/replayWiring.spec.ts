// The open-web engines, the reranker and the embedder send every request through
// replayAwareFetch, which replays it when the request's context carries a replay mode (its own
// routing is pinned in openaiClient.spec.ts), so a scenario run never reaches them live. (SOL-262)
import { afterEach, describe, expect, it, vi } from "vitest";

const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./entityCorrection", () => ({ correctEntityQuery: vi.fn().mockResolvedValue(undefined) }));

const json = (body: string) => new Response(body, { headers: { "content-type": "application/json" } });
const answer = (url: string): Response => {
	if (url.includes("export.arxiv.org")) return new Response('<?xml version="1.0"?><feed></feed>');
	if (url.includes("/rerank")) return json("[]");
	if (url.includes("feature-extraction")) return json("[0.1,0.2]");
	return json("{}");
};
const { replayAwareFetch } = vi.hoisted(() => ({ replayAwareFetch: vi.fn() }));
vi.mock("$lib/chat/server/openaiClient", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/openaiClient")>()),
	replayAwareFetch,
}));

import { retrieveWeb } from "./openSearch";
import { rerankByRelevance } from "./rerank";
import { embedText, embedTexts } from "../rag/embed";
import { queryEmbedCache } from "../rag/embedCache";

const sentUrls = () => replayAwareFetch.mock.calls.map((c) => String(c[0]));
const stubLiveFetch = () => {
	const live = vi.fn();
	vi.stubGlobal("fetch", live);
	replayAwareFetch.mockImplementation(async (url: string) => answer(String(url)));
	return live;
};

afterEach(() => {
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
	replayAwareFetch.mockReset();
	queryEmbedCache.clear();
});

describe("replayable search and retrieval calls (SOL-262)", () => {
	it("sends Wikipedia, Wikinews, OpenAlex, arXiv and Hugging Face through replayAwareFetch and never calls fetch directly", async () => {
		const live = stubLiveFetch();
		await retrieveWeb("benchmark results in a recent research paper", {
			wikipedia: 2,
			wikinews: 2,
			firecrawl: 0,
			openalex: 2,
			arxiv: 2,
			huggingface: 2,
		});
		const urls = sentUrls();
		for (const host of [
			"en.wikipedia.org/w/api.php",
			"wikinews.org/w/api.php",
			"api.openalex.org/works",
			"export.arxiv.org/api/query",
			"huggingface.co/api/models",
		]) {
			expect(urls.some((u) => u.includes(host)), host).toBe(true);
		}
		expect(live).not.toHaveBeenCalled();
	});

	it("sends each rerank transport (gateway, HF, TEI) through replayAwareFetch and never calls fetch directly", async () => {
		const live = stubLiveFetch();
		const cands = [
			{ title: "A", snippet: "a" },
			{ title: "B", snippet: "b" },
		];
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://gw.test/v1";
		configValues.OPENAI_API_KEY = "k";
		await rerankByRelevance("q", cands);
		configValues.RERANK_KIND = "hf";
		configValues.HF_TOKEN = "hf_test";
		await rerankByRelevance("q", cands);
		configValues.RERANK_ENDPOINT_URL = "https://tei.test";
		await rerankByRelevance("q", cands);
		const urls = sentUrls();
		expect(urls).toHaveLength(3);
		expect(urls[0]).toMatch(/gw\.test\/v1\/rerank$/);
		expect(urls[1]).toContain("/hf-inference/models/m");
		expect(urls[2]).toMatch(/tei\.test\/rerank$/);
		expect(live).not.toHaveBeenCalled();
	});

	it("sends embedText and embedTexts through replayAwareFetch and never calls fetch directly", async () => {
		const live = stubLiveFetch();
		await embedText("hello");
		await embedTexts(["a", "b"]);
		const urls = sentUrls();
		expect(urls).toHaveLength(2);
		expect(urls.every((u) => u.includes("feature-extraction"))).toBe(true);
		expect(live).not.toHaveBeenCalled();
	});
});

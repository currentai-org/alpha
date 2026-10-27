import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SearchSource } from "$lib/chat/types/Search";

// Mock the openSearch seam: retrieveWeb is the network fan-out (mocked per test); numberWebSources is
// faithfully reimplemented here (the REAL one — a trivial pure fn — is tested directly in
// openSearch.spec) so this spec verifies runWebSearch feeds retrieveWeb's `merged` into it at the right
// startAt. searchDecision is mocked only so importing runSearch stays hermetic (decideWebSearch's
// model deps aren't loaded); it's not tested here.
const h = vi.hoisted(() => ({
	retrieveWeb: vi.fn(),
	classifySearchNeed: vi.fn(),
	decideSearchViaTool: vi.fn(),
	decideSearchViaIntent: vi.fn(),
	searchIntentEnabled: vi.fn(() => true),
	warn: vi.fn(),
	info: vi.fn(),
	cfg: {} as Record<string, string>,
}));
vi.mock("./openSearch", () => ({
	retrieveWeb: h.retrieveWeb,
	numberWebSources: (merged: { title: string }[], startAt: number) => {
		const sources = merged.map((s, i) => ({ ...s, n: startAt + i + 1 }));
		return { sources, evidence: sources.map((s) => `[${s.n}] ${s.title}`).join("\n\n") };
	},
}));
vi.mock("./queryRewrite", () => ({ contextualizeQuery: vi.fn(async (q: string) => q) }));
vi.mock("./searchDecision", () => ({
	classifySearchNeed: h.classifySearchNeed,
	decideSearchViaTool: h.decideSearchViaTool,
}));
vi.mock("./searchIntent", () => ({
	decideSearchViaIntent: h.decideSearchViaIntent,
	searchIntentEnabled: h.searchIntentEnabled,
}));
// The deciding model's identity (CUR-984): the registry default and the embedder's own address.
vi.mock("$lib/chat/server/models", () => ({
	defaultModel: {
		id: "mistral-large-2512",
		endpoints: [{ type: "openai", baseURL: "https://api.mistral.ai/v1", apiKeyEnv: "MISTRAL_API_KEY" }],
	},
}));
vi.mock("$lib/chat/server/rag/env", () => ({
	embeddingModel: () => "Qwen/Qwen3-Embedding-0.6B",
	embeddingEndpointUrl: () => "",
	embeddingBaseUrl: () => "https://router.huggingface.co/hf-inference/models",
}));
vi.mock("$lib/chat/server/config", () => ({ config: h.cfg }));
// failOpen.ts logs through this same logger, so its departure line lands on h.warn.
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: h.warn, info: h.info } }));

import { decideWebSearch, deciderImages, runWebRetrieval, runWebSearch } from "./runSearch";

const merged: Omit<SearchSource, "n">[] = [
	{ title: "Alpha", url: "https://a.example", snippet: "sa", engine: "Wikipedia" },
	{ title: "Beta", url: "https://b.example", snippet: "sb", engine: "OpenAlex" },
];

beforeEach(() => h.retrieveWeb.mockReset());

describe("runWebRetrieval — deferred numbering (§5.1)", () => {
	it("returns UNNUMBERED merged hits (no `n`) so the caller numbers at the join", async () => {
		h.retrieveWeb.mockResolvedValue({ query: "q", merged, asOf: "t", relevanceVerified: true });
		const r = await runWebRetrieval("q", { locals: undefined });
		expect(r?.merged).toEqual(merged);
		expect(r?.merged.every((m) => !("n" in m))).toBe(true);
	});

	it("returns the (empty) outcome when a round-trip ran but nothing verified — searched≠skipped", async () => {
		// A completed-but-empty search must be distinguishable from "no search ran" (undefined) so the trace
		// records searched=true. numberWebSources([]) later yields 0 sources → grounds nothing.
		h.retrieveWeb.mockResolvedValue({ query: "q", merged: [], asOf: "t", relevanceVerified: true });
		const r = await runWebRetrieval("q", { locals: undefined });
		expect(r).toBeDefined();
		expect(r?.merged).toEqual([]);
	});

	it("returns undefined (never throws) when retrieval yields a malformed result", async () => {
		// A resolved-but-malformed outcome (merged missing, relevanceVerified truthy) makes `r.merged.length`
		// throw a TypeError inside the try → the catch returns undefined. Exercises the fail-open catch without
		// a rejected promise (which vitest's unhandled-rejection detector flags even when the code catches it).
		h.retrieveWeb.mockResolvedValue({ query: "q", asOf: "t", relevanceVerified: true });
		await expect(runWebRetrieval("q", { locals: undefined })).resolves.toBeUndefined();
	});

	it("rejects an over-long query without calling retrieveWeb", async () => {
		expect(await runWebRetrieval("x".repeat(401), { locals: undefined })).toBeUndefined();
		expect(h.retrieveWeb).not.toHaveBeenCalled();
	});

	// A retrieval that never settles must not hold the turn until the 45s generation watchdog (CUR-4089).
	it("returns undefined and logs the cut when retrieval never settles, instead of holding the turn forever", async () => {
		vi.useFakeTimers();
		try {
			h.warn.mockClear();
			h.retrieveWeb.mockReturnValueOnce(new Promise(() => {}));
			const pending = runWebRetrieval("q", { locals: undefined }, 15_000);
			await vi.advanceTimersByTimeAsync(14_999);
			let settled = false;
			void pending.then(() => (settled = true));
			await vi.advanceTimersByTimeAsync(0);
			expect(settled, "cut before the deadline").toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toBeUndefined();
			expect(h.warn).toHaveBeenCalledWith(
				expect.objectContaining({ deadlineMs: 15_000 }),
				"[search] web retrieval passed its deadline; answering ungrounded"
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("names the stage and the engines still pending when the deadline cuts the leg", async () => {
		vi.useFakeTimers();
		try {
			h.warn.mockClear();
			h.retrieveWeb.mockImplementationOnce(
				(_q: string, o: { progress?: { stage: string; pending: Set<string> } }) => {
					if (o.progress) {
						o.progress.stage = "engines";
						o.progress.pending.add("wikipedia-en");
						o.progress.pending.add("arxiv");
					}
					return new Promise(() => {});
				}
			);
			const pending = runWebRetrieval("q", { locals: undefined }, 15_000);
			await vi.advanceTimersByTimeAsync(15_000);
			await expect(pending).resolves.toBeUndefined();
			expect(h.warn).toHaveBeenCalledWith(
				expect.objectContaining({ stage: "engines", pendingEngines: ["arxiv", "wikipedia-en"] }),
				"[search] web retrieval passed its deadline; answering ungrounded"
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a retrieval that answers inside the deadline is returned whole and logs no cut", async () => {
		h.warn.mockClear();
		h.retrieveWeb.mockResolvedValue({ query: "q", merged, asOf: "t", relevanceVerified: true });
		const r = await runWebRetrieval("q", { locals: undefined }, 15_000);
		expect(r?.merged).toEqual(merged);
		expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("deadline"));
	});
});

// An engaged search that yields nothing must say why, or the turn reads as one nobody ran. (CUR-4091)
describe("runWebRetrieval — says why a leg that ran produced no outcome", () => {
	it("reports a leg cut at its deadline as a timeout", async () => {
		vi.useFakeTimers();
		try {
			h.retrieveWeb.mockReturnValueOnce(new Promise(() => {}));
			const onFailed = vi.fn();
			const pending = runWebRetrieval("q", { locals: undefined, onFailed }, 15_000);
			await vi.advanceTimersByTimeAsync(15_000);
			await expect(pending).resolves.toBeUndefined();
			expect(onFailed.mock.calls).toEqual([["timeout"]]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports a leg that throws as an error", async () => {
		// Malformed outcome: `r.merged.length` throws inside the try (see the fail-open test above).
		h.retrieveWeb.mockResolvedValueOnce({ query: "q", asOf: "t", relevanceVerified: true });
		const onFailed = vi.fn();
		await expect(runWebRetrieval("q", { locals: undefined, onFailed })).resolves.toBeUndefined();
		expect(onFailed.mock.calls).toEqual([["error"]]);
	});

	it("reports no failure for a leg that completed empty, or for a query the guard refused", async () => {
		h.retrieveWeb.mockResolvedValueOnce({ query: "q", merged: [], asOf: "t", relevanceVerified: true });
		const onFailed = vi.fn();
		await runWebRetrieval("q", { locals: undefined, onFailed });
		await runWebRetrieval("x".repeat(401), { locals: undefined, onFailed });
		expect(onFailed).not.toHaveBeenCalled();
	});

	it("the web_search_hangs fault holds the leg until the deadline, without calling the engines", async () => {
		vi.useFakeTimers();
		try {
			h.retrieveWeb.mockClear();
			const onFailed = vi.fn();
			const pending = runWebRetrieval("q", { locals: undefined, onFailed, hang: true }, 15_000);
			await vi.advanceTimersByTimeAsync(15_000);
			await expect(pending).resolves.toBeUndefined();
			expect(onFailed.mock.calls).toEqual([["timeout"]]);
			expect(h.retrieveWeb).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("runWebSearch — numbers community-first at startAt (§5.1)", () => {
	it("numbers hits from startAt+1 with a matching evidence block", async () => {
		h.retrieveWeb.mockResolvedValue({ query: "q", merged, asOf: "t", relevanceVerified: true });
		const r = await runWebSearch("q", { locals: undefined, startAt: 2 });
		expect(r?.sources.map((s) => s.n)).toEqual([3, 4]);
		expect(r?.evidence).toContain("[3] Alpha");
		expect(r?.evidence).toContain("[4] Beta");
		expect(r?.relevanceVerified).toBe(true);
	});

	it("startAt defaults to 0 (web-only turn ⇒ [1..])", async () => {
		h.retrieveWeb.mockResolvedValue({ query: "q", merged, asOf: "t", relevanceVerified: true });
		const r = await runWebSearch("q", { locals: undefined });
		expect(r?.sources.map((s) => s.n)).toEqual([1, 2]);
	});

	it("returns a 0-source outcome when a round-trip ran but found nothing (searched, not skipped)", async () => {
		h.retrieveWeb.mockResolvedValue({ query: "q", merged: [], asOf: "t", relevanceVerified: false });
		const r = await runWebSearch("q", { locals: undefined, startAt: 0 });
		expect(r?.sources).toEqual([]);
		expect(r?.relevanceVerified).toBe(false);
	});

	it("returns undefined when the search DIDN'T run (over-long query guard)", async () => {
		expect(await runWebSearch("x".repeat(401), { locals: undefined })).toBeUndefined();
		expect(h.retrieveWeb).not.toHaveBeenCalled();
	});
});

// CUR-2108. A decider that gives no verdict hands the turn to a fallback: search under margin
// (CUR-2109), the recency regex under model/tool. That hand-off is a fail-open departure and must be
// counted as one, and the decision line must say which decider ran, so a fallback can never be read
// as a model "no". Each case names the decider and the path.
describe("decideWebSearch — names its decider and logs every fallback (CUR-2108)", () => {
	// Timeless and carries no recency or lookup words, so any search here came from the decider.
	const TEXT = "who painted the ceiling of the sistine chapel";

	const departures = () => h.warn.mock.calls.filter(([o]) => o?.failopen === "search-decision");
	const decisionLine = () =>
		h.info.mock.calls.find(([, msg]) => msg === "[search] decision")?.[0] as Record<string, unknown>;

	beforeEach(() => {
		for (const k of Object.keys(h.cfg)) delete h.cfg[k];
		h.warn.mockReset();
		h.info.mockReset();
		h.classifySearchNeed.mockReset();
		h.decideSearchViaTool.mockReset();
		h.decideSearchViaIntent.mockReset();
		h.searchIntentEnabled.mockReset().mockReturnValue(true);
	});

	it("margin: the embedding gate decides, and a verdict logs no departure", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({ shouldSearch: true, ok: true, margin: 0.2 });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ search: true, decider: "embedding", fallback: undefined });
		expect(departures()).toHaveLength(0);
		expect(decisionLine()).toMatchObject({ decider: "embedding", classifierOk: true });
	});

	it("margin: an embedding failure logs one departure naming its reason", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({
			shouldSearch: false,
			ok: false,
			margin: 0,
			reason: "no-vector",
		});
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ search: true, decider: "embedding", fallback: "embedding-no-vector" });
		expect(departures()).toHaveLength(1);
		expect(departures()[0][0]).toMatchObject({ reason: "embedding-no-vector", strategy: "margin" });
	});

	it("margin: a failed gate searches a timeless question, and the decision line says it was the fallback", async () => {
		// TEXT has no recency word, so the regex fallback would decline. The search here can
		// only have come from the no-verdict-means-search rule (CUR-2109).
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({ shouldSearch: false, ok: false, margin: 0, reason: "threw" });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.search).toBe(true);
		expect(decisionLine()).toMatchObject({
			fallback: "embedding-threw",
			classifierOk: false,
			reason: "fallback",
		});
	});

	it("margin: the gate's no stands even when both regexes would have searched", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({ shouldSearch: false, ok: true, margin: -0.3 });
		const d = await decideWebSearch("can you look this up: the latest news", undefined, true);
		expect(d.search).toBe(false);
		expect(decisionLine()).toMatchObject({ explicitLookupHit: true, heuristicHit: true, reason: "none" });
	});

	it("margin: the embedding flag off is a departure, not a silent switch to another gate", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.searchIntentEnabled.mockReturnValue(false);
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ search: true, decider: "none", fallback: "embedding-gate-off" });
		expect(h.decideSearchViaIntent).not.toHaveBeenCalled();
		expect(departures()).toHaveLength(1);
	});

	it("model: the completion decider's verdict decides with no departure", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: true, ok: true });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ search: true, decider: "completion", fallback: undefined });
		expect(departures()).toHaveLength(0);
	});

	// A bare "now" in an app question matches the recency regex, which must not override the
	// classifier's no and send the turn to the web (CUR-2372).
	it("model: a recency-regex hit does not override the completion decider's no", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: true });
		const d = await decideWebSearch("If I sign in later, does the chat I'm having now carry over?", undefined, true);
		expect(d).toMatchObject({ search: false, decider: "completion", fallback: undefined });
		expect(decisionLine()).toMatchObject({ heuristicHit: true, classifierHit: false, reason: "none" });
	});

	it("model: when the completion call fails, a recency-regex hit still searches", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch("what's the latest on the Swiss election", undefined, true);
		expect(d).toMatchObject({ search: true, fallback: "completion-failed" });
		expect(decisionLine()).toMatchObject({ reason: "heuristic" });
	});

	it("model: the completion classifier is a side call, never handed the turn's model (CUR-2092)", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: true });
		await decideWebSearch(TEXT, undefined, false, { id: "mistral-large-2512" });
		expect(h.classifySearchNeed.mock.calls[0]).toEqual([TEXT, undefined, []]);
	});

	// A file never switches search off. The decider is told what came with the message and
	// still decides, so its yes on a photo turn is a search. (CUR-3192)
	it("model: a turn with a photo tells the classifier, and its yes still searches", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: true, ok: true });
		const d = await decideWebSearch("where can I buy these shoes", undefined, false, undefined, ["image"]);
		expect(h.classifySearchNeed.mock.calls[0]).toEqual(["where can I buy these shoes", undefined, ["image"]]);
		expect(d).toMatchObject({ search: true, decider: "completion" });
		expect(decisionLine()).toMatchObject({ attachments: 1 });
	});

	it("margin: a turn with a file goes to the classifier, which can be told about it; the text-only embedding gate is not asked", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: true });
		const d = await decideWebSearch("What's in this picture?", undefined, false, undefined, ["image"]);
		expect(h.decideSearchViaIntent).not.toHaveBeenCalled();
		expect(h.classifySearchNeed.mock.calls[0][2]).toEqual(["image"]);
		expect(d).toMatchObject({ search: false, decider: "completion", fallback: undefined });
	});

	it("margin: a file turn whose classifier call fails still searches, as every margin no-verdict does", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch("What's in this picture?", undefined, false, undefined, ["image"]);
		expect(d).toMatchObject({ search: true, fallback: "completion-failed" });
	});

	it("tool: a turn with a document passes it to the tool decider", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "tool";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: true, ok: true, query: "rota law" });
		await decideWebSearch(TEXT, undefined, false, undefined, ["document"]);
		expect(h.decideSearchViaTool.mock.calls[0][3]).toEqual(["document"]);
	});

	// With the photo in hand, the serving model decides and writes the query from what it sees,
	// whatever the strategy, the way Google's AI Mode and ChatGPT search an image. (CUR-3192)
	const PHOTO = [{ mime: "image/jpeg", b64: "AAAA" }];

	it("vision: a photo question the model answers from the image runs no search, under every strategy", async () => {
		for (const strategy of ["margin", "model", "tool"]) {
			h.cfg.PUBLIC_SEARCH_TRIGGER = strategy;
			h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: true });
			const d = await decideWebSearch("What brand is the logo in this picture?", undefined, false, undefined, ["image"], PHOTO);
			expect(d, strategy).toMatchObject({ search: false, decider: "vision", fallback: undefined });
		}
		expect(h.decideSearchViaIntent).not.toHaveBeenCalled();
		expect(h.classifySearchNeed).not.toHaveBeenCalled();
		expect(h.decideSearchViaTool.mock.calls[0][4]).toEqual(PHOTO);
	});

	it("vision: when the model searches, the query is the one it wrote from the photo, not the typed words", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: true, ok: true, query: "Acme trail runner 3 price" });
		const d = await decideWebSearch("where can I buy these?", undefined, false, undefined, ["image"], PHOTO);
		expect(d).toMatchObject({ search: true, query: "Acme trail runner 3 price", preShaped: true, decider: "vision" });
		expect(decisionLine()).toMatchObject({ images: 1, reason: "classifier" });
	});

	it("vision: the recency regex on the typed words cannot force a search the model declined", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: true });
		const d = await decideWebSearch("what's the latest thing in this photo", undefined, true, undefined, ["image"], PHOTO);
		expect(d.search).toBe(false);
	});

	it("vision: a failed call falls back to no search (fail closed), never to a search on the typed words", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch("What's in this picture?", undefined, false, undefined, ["image"], PHOTO);
		expect(d).toMatchObject({ search: false, decider: "vision", fallback: "vision-call-failed" });
	});

	it("vision: an explicit 'look this up' with a photo still searches when the call fails", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch("look this up online", undefined, false, undefined, ["image"], PHOTO);
		expect(d.search).toBe(true);
	});

	it("deciderImages: the newest two photos in the conversation, as their JPEG screening renditions", () => {
		const media = { screen: { images: [{ screenB64: "a" }, { screenB64: "b" }, { screenB64: "c" }] } };
		expect(deciderImages(media)).toEqual([
			{ mime: "image/jpeg", b64: "b" },
			{ mime: "image/jpeg", b64: "c" },
		]);
		expect(deciderImages(undefined)).toEqual([]);
	});

	it("model: a failed completion call is a departure, not a model 'no'", async () => {
		// A quiet fallback is what the production path must not have: classifySearchNeed swallowing every error
		// and returning false would be recorded by the decision line exactly like the model declining (CUR-2108).
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ search: false, decider: "completion", fallback: "completion-failed" });
		expect(departures()).toHaveLength(1);
	});

	it("tool: a failed tool call is a departure", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "tool";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: false });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ decider: "tool", fallback: "tool-call-failed" });
		expect(departures()).toHaveLength(1);
	});

	it("a decider that throws is a departure with reason 'threw'", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockRejectedValue(new Error("boom"));
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.fallback).toBe("threw");
		expect(departures()).toHaveLength(1);
	});

	it("heuristic: no model decider runs, so there is nothing to fall back from", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "heuristic";
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d).toMatchObject({ decider: "none", fallback: undefined });
		expect(departures()).toHaveLength(0);
	});
});

describe("decideWebSearch — names the model that decided, and only when one did (CUR-984)", () => {
	const TEXT = "who painted the ceiling of the sistine chapel";

	beforeEach(() => {
		for (const k of Object.keys(h.cfg)) delete h.cfg[k];
		h.classifySearchNeed.mockReset();
		h.decideSearchViaTool.mockReset();
		h.decideSearchViaIntent.mockReset();
		h.searchIntentEnabled.mockReset().mockReturnValue(true);
	});

	it("margin: the embedding model and its host are the decider, keeping the host and not the path", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({ shouldSearch: false, ok: true, margin: -0.1 });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.assist).toEqual({
			role: "search-decision",
			model: "Qwen/Qwen3-Embedding-0.6B",
			backend: "router.huggingface.co",
		});
	});

	it("margin: a failed embedding gate names no decider, since a fallback decided instead", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "margin";
		h.decideSearchViaIntent.mockResolvedValue({ shouldSearch: false, ok: false, reason: "no-vector" });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.assist).toBeUndefined();
	});

	it("model: the completion decider names the model and host the endpoint reported serving it", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "model";
		h.classifySearchNeed.mockResolvedValue({
			shouldSearch: true,
			ok: true,
			served: { model: "mistral-small-2603", backend: "api.mistral.ai" },
		});
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.assist).toEqual({
			role: "search-decision",
			model: "mistral-small-2603",
			backend: "api.mistral.ai",
		});
	});

	it("tool: the serving model's own lane decides, so its host is named", async () => {
		h.cfg.PUBLIC_SEARCH_TRIGGER = "tool";
		h.decideSearchViaTool.mockResolvedValue({ shouldSearch: false, ok: true });
		const d = await decideWebSearch(TEXT, undefined, false);
		expect(d.assist).toMatchObject({ role: "search-decision", backend: "api.mistral.ai" });
	});
});

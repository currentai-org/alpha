import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { configValues } = vi.hoisted(() => ({ configValues: {} as Record<string, string> }));
vi.mock("$lib/chat/server/config", () => ({ config: configValues }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
// Defaults every test to a no-op corrector (undefined = nothing to correct) so the existing suite
// never pays a real model-call round-trip through the mocked fetch below. Tests that actually exercise
// the correction branch override this with mockResolvedValueOnce.
vi.mock("./entityCorrection", () => ({ correctEntityQuery: vi.fn().mockResolvedValue(undefined) }));
// Every flag answers its own fallback (the unpolled state) unless a test names it in flagsOn.
const { flagsOn } = vi.hoisted(() => ({ flagsOn: new Set<string>() }));
vi.mock("$lib/chat/server/flags", async (orig) => ({
	...(await orig<typeof import("$lib/chat/server/flags")>()),
	flagEnabledOr: (key: string, fallback: () => boolean) => flagsOn.has(key) || fallback(),
}));

import {
	markdownToExcerpt,
	openSearch,
	retrieveWeb,
	numberWebSources,
	buildWebEvidence,
	type WebProgress,
} from "./openSearch";
import { correctEntityQuery } from "./entityCorrection";
import type { SearchSource } from "$lib/chat/types/Search";
import { logger } from "$lib/chat/server/logger";

type Resp = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
const okJson = (x: unknown): Resp => ({ ok: true, status: 200, json: async () => x, text: async () => "" });
const okText = (t: string): Resp => ({ ok: true, status: 200, json: async () => ({}), text: async () => t });

afterEach(() => {
	flagsOn.clear();
	for (const k of Object.keys(configValues)) delete configValues[k];
	vi.unstubAllGlobals();
	vi.mocked(correctEntityQuery).mockReset().mockResolvedValue(undefined);
});

// llm-stats' release list, verbatim as Firecrawl's search description returned it. A model can read
// "Anthropic•6d ago" straight into "GPT-6 Luna" and credit OpenAI's model to Anthropic (CUR-2207).
const LLM_STATS_DESCRIPTION =
	"## AI Model Releases [![Anthropic](https://llm-stats.com/_next/image?url=%2Flogos%2Fanthropic-dark.png&w=64&q=75)\\ \\ **Claude Opus 5.5** ReleaseProprietary\\ \\ Anthropic•6d ago](https://llm-stats.com/models/claude-opus-5-5) [![OpenAI](https://llm-stats.com/_next/image?url=%2Flogos%2Fopenai-dark.png&w=64&q=75)\\ \\ **GPT-6 Luna** ReleaseProprietary\\ \\ OpenAI•6d ago](https://llm-stats.com/models/gpt-6-luna)";

describe("markdownToExcerpt on one line of markdown", () => {
	it("keeps each listing row's company with its own model, with a separator between rows", () => {
		const text = markdownToExcerpt(LLM_STATS_DESCRIPTION, 500);
		expect(text).toBe(
			"AI Model Releases Claude Opus 5.5 ReleaseProprietary Anthropic•6d ago; GPT-6 Luna ReleaseProprietary OpenAI•6d ago"
		);
		expect(text).not.toContain("http");
	});

	it("leaves a plain search description's words unchanged, including C# and a leading #1", () => {
		const plain = "Learn C# in a weekend: #1 ranked course, 4.8 stars.  Updated   2026.";
		expect(markdownToExcerpt(plain, 500)).toBe("Learn C# in a weekend: #1 ranked course, 4.8 stars. Updated 2026.");
	});

	it("unwraps a link inside a sentence without adding a separator", () => {
		expect(markdownToExcerpt("The [European Commission](https://ec.europa.eu) proposed rules.", 500)).toBe(
			"The European Commission proposed rules."
		);
	});

	it("drops ** bold markers but keeps a dunder name like __init__ whole", () => {
		expect(markdownToExcerpt("Python's **constructor** is __init__, called on every new instance.", 500)).toBe(
			"Python's constructor is __init__, called on every new instance."
		);
	});
});

describe("markdownToExcerpt", () => {
	it("strips nav links, images, and blockquote CTAs, keeping substantial paragraphs", () => {
		const markdown = `[Skip to main content](https://example.com/page#main-content)

![](https://example.com/logo.webp)

X

[Scroll down to content](https://example.com/page#content)

# AI Watch: Global regulatory tracker

What's inside

> Subscribe
>
> We encourage you to subscribe to receive AI-related updates.
>
> [Subscribe here](https://example.com/subscribe)

Artificial intelligence (AI) has made enormous strides in recent years and has increasingly moved into the public consciousness. Governments worldwide are racing to build regulatory frameworks that keep pace with rapid technical change.

## The global dash to regulate AI

Increases in computational power, coupled with advances in machine learning, have fueled the rapid rise of AI applications across every sector of the economy.`;

		const excerpt = markdownToExcerpt(markdown, 600);

		expect(excerpt).not.toContain("Skip to main content");
		expect(excerpt).not.toContain("Subscribe");
		expect(excerpt).not.toContain("http");
		expect(excerpt).toContain("Artificial intelligence (AI) has made enormous strides");
		expect(excerpt.length).toBeLessThanOrEqual(600);
	});

	it("unwraps inline links to their visible text instead of dropping the sentence", () => {
		const markdown =
			"The [European Commission](https://ec.europa.eu) proposed new rules today covering high-risk AI systems and biometric surveillance across all member states.";
		const excerpt = markdownToExcerpt(markdown, 600);
		expect(excerpt).toContain("The European Commission proposed new rules today");
		expect(excerpt).not.toContain("ec.europa.eu");
	});

	it("returns empty string for pure boilerplate with nothing substantial", () => {
		const markdown = `[Skip](https://x.com)

![](https://x.com/logo.png)

X

> Subscribe now`;
		expect(markdownToExcerpt(markdown, 600)).toBe("");
	});

	it("caps output at maxChars even with abundant content", () => {
		const longParagraph = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(30);
		expect(markdownToExcerpt(longParagraph, 100).length).toBeLessThanOrEqual(100);
	});
});


describe("numberWebSources + buildWebEvidence — community-first numbering (§5.1)", () => {
	const merged: Omit<SearchSource, "n">[] = [
		{
			title: "Alpha",
			url: "https://a.example",
			snippet: "sa",
			engine: "Wikipedia",
			asOf: "2026-01-02T00:00:00Z",
		},
		{ title: "Beta", url: "https://b.example", snippet: "sb", engine: "OpenAlex", lang: "fr" },
	];

	it("numbers from startAt+1 and the evidence [n] markers match the sources' n exactly", () => {
		const { sources, evidence } = numberWebSources(merged, 3);
		expect(sources.map((s) => s.n)).toEqual([4, 5]);
		// The single numbering authority: every source's n is its [n] tag in the evidence, in order.
		for (const s of sources) expect(evidence).toContain(`[${s.n}] ${s.title}`);
		expect(evidence).toContain("[4] Alpha (Wikipedia, 2026-01-02)");
		expect(evidence).toContain("[5] Beta (OpenAlex FR, date unknown)");
		expect(evidence).toBe(buildWebEvidence(sources));
	});

	it("startAt 0 numbers [1..] (web-only turn)", () => {
		expect(numberWebSources(merged, 0).sources.map((s) => s.n)).toEqual([1, 2]);
	});

	it("is a no-op on an empty hit list", () => {
		expect(numberWebSources([], 5)).toEqual({ sources: [], evidence: "" });
	});
});

describe("retrieveWeb vs openSearch — deferred vs immediate numbering (§5.1)", () => {
	const wikiPage = (): Resp =>
		okJson({
			query: {
				pages: {
					"1": {
						title: "Vector database",
						extract: "A vector database stores embeddings for similarity search.",
						fullurl: "https://en.wikipedia.org/wiki/Vector_database",
						index: 1,
						touched: "2026-01-01T00:00:00Z",
					},
				},
			},
		});
	const routeFetch = (url: RequestInfo | URL): Promise<Response> => {
		const u = String(url);
		if (u.includes("wikipedia.org")) return Promise.resolve(wikiPage() as unknown as Response);
		if (u.includes("export.arxiv.org")) return Promise.resolve(okText("") as unknown as Response);
		return Promise.resolve(okJson({}) as unknown as Response);
	};
	beforeEach(() => vi.stubGlobal("fetch", vi.fn(routeFetch)));

	it("retrieveWeb returns UNNUMBERED merged hits (no `n`) so the caller numbers at the join", async () => {
		const r = await retrieveWeb("what is a vector database", { perEngineTimeoutMs: 500 });
		expect(r.merged.length).toBeGreaterThan(0);
		expect(r.merged.every((m) => !("n" in m))).toBe(true);
	});

	it("openSearch applies startAt so web sources continue after community ([k+1..])", async () => {
		const result = await openSearch("what is a vector database", {
			perEngineTimeoutMs: 500,
			startAt: 2,
		});
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.sources[0].n).toBe(3);
		expect(result.evidence).toContain(`[3] ${result.sources[0].title}`);
	});
});

describe("rerankText — populated for metadata-thin engines, never reaches the wire (CUR-78)", () => {
	const hfPage = (): Resp =>
		okJson([
			{
				id: "swiss-ai/Apertus-70B-Instruct-2509",
				downloads: 12000,
				pipeline_tag: "text-generation",
				tags: ["transformers", "safetensors", "conversational"],
				createdAt: "2026-05-01T00:00:00Z",
			},
		]);
	const openAlexPage = (): Resp =>
		okJson({
			results: [
				{
					id: "https://openalex.org/W1",
					title: "Open foundation models for European languages",
					doi: "https://doi.org/10.1/example",
					publication_date: "2026-03-01",
					primary_location: { source: { display_name: "Proceedings of ACL" } },
					abstract_inverted_index: { A: [0], study: [1], of: [2], open: [3], models: [4] },
				},
			],
		});
	const routeFetch = (url: RequestInfo | URL): Promise<Response> => {
		const u = String(url);
		if (u.includes("huggingface.co/api/models")) return Promise.resolve(hfPage() as unknown as Response);
		if (u.includes("api.openalex.org")) return Promise.resolve(openAlexPage() as unknown as Response);
		if (u.includes("export.arxiv.org")) return Promise.resolve(okText("") as unknown as Response);
		return Promise.resolve(okJson({}) as unknown as Response);
	};
	beforeEach(() => vi.stubGlobal("fetch", vi.fn(routeFetch)));

	it("HF candidate's rerankText carries the id path + pipeline_tag + full tag list, richer than the capped snippet", async () => {
		const r = await retrieveWeb("apertus model card", {
			huggingface: 1,
			wikipedia: 0,
			wikinews: 0,
			firecrawl: 0,
			openalex: 0,
			arxiv: 0,
			perEngineTimeoutMs: 500,
		});
		const hf = r.merged.find((m) => m.engine === "Hugging Face");
		expect(hf?.rerankText).toBe(
			"swiss-ai/Apertus-70B-Instruct-2509 · text-generation · transformers, safetensors, conversational"
		);
	});

	it("OpenAlex candidate's rerankText carries BOTH venue and abstract, which the snippet alone drops one of", async () => {
		const r = await retrieveWeb("open foundation models", {
			openalex: 1,
			wikipedia: 0,
			wikinews: 0,
			firecrawl: 0,
			huggingface: 0,
			arxiv: 0,
			perEngineTimeoutMs: 500,
		});
		const oa = r.merged.find((m) => m.engine === "OpenAlex");
		expect(oa?.rerankText).toBe("Proceedings of ACL · A study of open models");
		// the snippet (model/citation-facing) drops the venue once an abstract exists — confirms
		// rerankText is carrying something the snippet genuinely doesn't.
		expect(oa?.snippet).not.toContain("Proceedings of ACL");
	});

	it("rerankText never reaches the final wire sources — numberWebSources drops it (the actual leak this ticket closes)", async () => {
		const result = await openSearch("apertus model card", {
			huggingface: 1,
			wikipedia: 0,
			wikinews: 0,
			firecrawl: 0,
			openalex: 0,
			arxiv: 0,
			perEngineTimeoutMs: 500,
		});
		expect(result.sources.length).toBeGreaterThan(0);
		for (const s of result.sources) expect("rerankText" in s).toBe(false);
		// and the serialized JSON (what actually crosses the wire) carries no trace of it either
		expect(JSON.stringify(result.sources)).not.toContain("rerankText");
	});
});

describe("openSearch — #1 intent routing skips zero-budget engines", () => {
	it("a confident research query does NOT launch Wikinews (budget 0)", async () => {
		configValues.RERANK_MODEL = "m";
		configValues.OPENAI_BASE_URL = "https://cscs/v1";
		configValues.OPENAI_API_KEY = "k";
		const fetchMock = vi.fn(async (url: string): Promise<Resp> => {
			if (String(url).includes("export.arxiv.org")) return okText("");
			return okJson({});
		});
		vi.stubGlobal("fetch", fetchMock);

		await openSearch("benchmark results in a recent research paper");
		const urls = fetchMock.mock.calls.map((c) => String(c[0]));
		expect(urls.some((u) => u.includes("wikinews.org"))).toBe(false);
		expect(urls.some((u) => u.includes("api.openalex.org"))).toBe(true);
		expect(urls.some((u) => u.includes("export.arxiv.org"))).toBe(true);
	});
});

describe("openSearch per-engine timeout", () => {
	const wikiPage = (): Resp =>
		okJson({
			query: {
				pages: {
					"1": {
						title: "Vector database",
						extract: "A vector database stores embeddings for similarity search.",
						fullurl: "https://en.wikipedia.org/wiki/Vector_database",
						index: 1,
						touched: "2026-01-01T00:00:00Z",
					},
				},
			},
		});

	const routeFetch = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const u = String(url);
		if (u.includes("export.arxiv.org")) {
			return new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
				signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
			});
		}
		if (u.includes("wikipedia.org")) return Promise.resolve(wikiPage() as unknown as Response);
		if (u.includes("wikinews.org"))
			return Promise.resolve(okJson({ query: { pages: {} } }) as unknown as Response);
		if (u.includes("api.firecrawl.dev"))
			return Promise.resolve(okJson({ data: [] }) as unknown as Response);
		if (u.includes("api.openalex.org"))
			return Promise.resolve(okJson({ results: [] }) as unknown as Response);
		if (u.includes("huggingface.co")) return Promise.resolve(okJson([]) as unknown as Response);
		return Promise.reject(new Error(`unexpected fetch: ${u}`));
	};

	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn(routeFetch));
	});

	it("bounds a hung engine at perEngineTimeoutMs and returns the fast engines' sources", async () => {
		const started = Date.now();
		const result = await openSearch("what is a vector database", {
			perEngineTimeoutMs: 50,
			timeoutMs: 5000,
		});
		const elapsed = Date.now() - started;

		expect(elapsed).toBeLessThan(2000);
		expect(result.sources.length).toBeGreaterThan(0);
		expect(result.sources.some((s) => s.engine === "Wikipedia")).toBe(true);
		expect(result.sources.some((s) => s.engine === "arXiv")).toBe(false);
	});

	it("clamps perEngineTimeoutMs to the overall timeoutMs for the FAST engines (never schedules a longer per-engine abort for them)", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		// 9500, not 9000, so it can't be confused with Firecrawl's own independent
		// DEFAULT_FIRECRAWL_TIMEOUT_MS (see the next two tests — CUR-633).
		await openSearch("what is a vector database", { perEngineTimeoutMs: 9500, timeoutMs: 60 });
		const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
		expect(delays).not.toContain(9500);
		expect(delays).toContain(60);
		setTimeoutSpy.mockRestore();
	});

	it("Firecrawl gets its own longer timeout, independent of timeoutMs/perEngineTimeoutMs (CUR-633)", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		await openSearch("what is a vector database", { perEngineTimeoutMs: 50, timeoutMs: 60 });
		const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
		// DEFAULT_FIRECRAWL_TIMEOUT_MS, scheduled regardless of the tiny master/per-engine caps above.
		expect(delays).toContain(9000);
		setTimeoutSpy.mockRestore();
	});

	it("Firecrawl's result survives the master's early abort — the actual CUR-633 regression: a slow-but-within-budget Firecrawl call used to be killed by the fast engines' shared clock", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		const delayedRouteFetch = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const u = String(url);
			if (u.includes("api.firecrawl.dev")) {
				return new Promise<Response>((resolve) => {
					setTimeout(
						() =>
							resolve(
								okJson({
									data: {
										web: [
											{
												url: "https://example.com/museum-hours",
												title: "Museum Hours",
												description: "Open today 10am-5pm.",
											},
										],
									},
								}) as unknown as Response
							),
						150
					);
				});
			}
			return routeFetch(url, init);
		};
		vi.stubGlobal("fetch", vi.fn(delayedRouteFetch));

		const result = await openSearch("museum hours today", {
			// Mirrors short fast-engine caps racing against Firecrawl's real multi-second latency
			// (CUR-633): a master/per-engine budget far shorter than Firecrawl's mocked 150ms delay. The
			// master's early abort must not kill this call too.
			timeoutMs: 50,
			perEngineTimeoutMs: 50,
		});

		expect(result.sources.some((s) => s.engine === "Firecrawl")).toBe(true);
	});

	it("a Firecrawl description that arrives as markdown reaches the model as text, one row per company (CUR-2207)", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		const firecrawlFetch = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			if (String(url).includes("api.firecrawl.dev")) {
				return Promise.resolve(
					okJson({
						data: {
							web: [{ url: "https://llm-stats.com/llm-updates", title: "AI Updates Today", description: LLM_STATS_DESCRIPTION }],
						},
					}) as unknown as Response
				);
			}
			return routeFetch(url, init);
		};
		vi.stubGlobal("fetch", vi.fn(firecrawlFetch));

		const result = await openSearch("open-source AI models news this week", { timeoutMs: 500, perEngineTimeoutMs: 500 });
		const source = result.sources.find((s) => s.url === "https://llm-stats.com/llm-updates");

		expect(source?.snippet).toContain("Anthropic•6d ago; GPT-6 Luna");
		expect(source?.snippet).not.toContain("_next/image");
	});
});

describe("openSearch — entity-name correction branch (CUR-877)", () => {
	const firecrawlResult = (title: string, url: string) =>
		okJson({ data: { web: [{ url, title, description: `${title} description` }] } });

	const routeFetch = (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("api.firecrawl.dev")) {
			const body = init?.body ? (JSON.parse(String(init.body)) as { query: string }) : undefined;
			if (body?.query === "goad pistilli") {
				return Promise.resolve(firecrawlResult("Wrong Person", "https://example.com/wrong") as unknown as Response);
			}
			if (body?.query === "giada pistilli") {
				return Promise.resolve(
					firecrawlResult("Giada Pistilli", "https://example.com/giada") as unknown as Response
				);
			}
			return Promise.resolve(okJson({ data: { web: [] } }) as unknown as Response);
		}
		if (u.includes("export.arxiv.org")) return Promise.resolve(okText("") as unknown as Response);
		return Promise.resolve(okJson({}) as unknown as Response);
	};

	it("does NOT run the correction branch when Firecrawl isn't configured — nothing for a correction to unlock", async () => {
		vi.stubGlobal("fetch", vi.fn(routeFetch));
		await openSearch("goad pistilli", { perEngineTimeoutMs: 500 });
		expect(correctEntityQuery).not.toHaveBeenCalled();
	});

	it("dispatches a second Firecrawl call with the corrected query and surfaces its result", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		vi.mocked(correctEntityQuery).mockResolvedValueOnce("giada pistilli");
		vi.stubGlobal("fetch", vi.fn(routeFetch));

		const result = await openSearch("goad pistilli", { perEngineTimeoutMs: 500 });

		expect(correctEntityQuery).toHaveBeenCalledWith("goad pistilli", undefined);
		const urls = result.sources.map((s) => s.url);
		expect(urls).toContain("https://example.com/giada");
		// The original (typo'd) query's own Firecrawl call still ran too — this is an addition, not a
		// replacement, and both candidates reach the same reranker/relevance gate.
		expect(urls).toContain("https://example.com/wrong");
	});

	it("skips the second dispatch when the correction call finds nothing (undefined) — the default mock behavior", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		const fetchMock = vi.fn(routeFetch);
		vi.stubGlobal("fetch", fetchMock);

		await openSearch("some ordinary query", { perEngineTimeoutMs: 500 });

		expect(correctEntityQuery).toHaveBeenCalled();
		const firecrawlCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("api.firecrawl.dev"));
		expect(firecrawlCalls.length).toBe(1); // only the primary Firecrawl call, no corrected-query dispatch
	});

	it("threads locals through to the correction call", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		vi.stubGlobal("fetch", vi.fn(routeFetch));
		const locals = { userId: "u1" } as unknown as App.Locals;

		await openSearch("goad pistilli", { perEngineTimeoutMs: 500, locals });

		expect(correctEntityQuery).toHaveBeenCalledWith("goad pistilli", locals);
	});
});

// Engines that ran and found nothing are an empty search, and record nothing. Every engine
// throwing reads the same to the user, so that is the departure. (CUR-68)
describe("retrieveWeb fail-open departures", () => {
	const departures = () =>
		vi
			.mocked(logger.warn)
			.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>)
			.filter((o) => o && typeof o === "object" && "failopen" in o)
			.map((o) => `${String(o.failopen)}:${String(o.reason)}`);
	beforeEach(() => vi.mocked(logger.warn).mockClear());
	afterEach(() => vi.unstubAllGlobals());

	it("records nothing when every engine answers empty", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) =>
				Promise.resolve(
					(String(url).includes("export.arxiv.org") ? okText("") : okJson({})) as unknown as Response
				)
			)
		);
		const r = await retrieveWeb("an obscure question", { perEngineTimeoutMs: 500 });
		expect(r.merged).toEqual([]);
		expect(departures()).toEqual([]);
	});

	it("records one search departure when every engine throws", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
		await retrieveWeb("an obscure question", { perEngineTimeoutMs: 500 });
		expect(departures()).toEqual(["search:every-engine-failed"]);
	});
});

// retrieveWeb reports where its time went, so the chat route can put the split on the
// `[retrieval] timing` line. Each engine's time is measured from the fan-out start, so the fan-out as a
// whole takes as long as its slowest engine. (CUR-2105)
describe("retrieveWeb stage timings", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("times every engine it asked, and the fan-out as long as the slowest", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: RequestInfo | URL) => {
				if (String(url).includes("wikipedia.org")) await new Promise((r) => setTimeout(r, 60));
				return (String(url).includes("export.arxiv.org") ? okText("") : okJson({})) as unknown as Response;
			})
		);
		const r = await retrieveWeb("what is a vector database", { perEngineTimeoutMs: 500 });
		const t = r.timings;
		expect(t).toBeDefined();
		const engines = Object.keys(t?.engineMs ?? {});
		expect(engines).toContain("wikipedia-en");
		expect(t?.engineMs["wikipedia-en"]).toBeGreaterThanOrEqual(55);
		expect(t?.enginesMs).toBeGreaterThanOrEqual(Math.max(...Object.values(t?.engineMs ?? {})));
		expect(typeof t?.rerankMs).toBe("number");
		expect(typeof t?.enrichMs).toBe("number");
	});
	// A leg that never settles logs nothing from inside, so the caller's deadline reads this to
	// name the stage and the engines that held it. (CUR-4089)
	it("reports the fan-out stage and only the engine still inside its cap while the leg is in flight", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				if (String(url).includes("export.arxiv.org")) return new Promise<Response>(() => {});
				return Promise.resolve(okJson({}) as unknown as Response);
			})
		);
		const progress: WebProgress = { stage: "rewrite", pending: new Set() };
		void retrieveWeb("what is a vector database", { perEngineTimeoutMs: 400, timeoutMs: 400, progress });
		await new Promise((r) => setTimeout(r, 60));
		expect(progress.stage).toBe("engines");
		expect([...progress.pending]).toEqual(["arxiv"]);
	});
	it("settles an engine that ignores its abort at its cap, so one hung fetch cannot hold the fan-out past it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				// Ignores its abort signal entirely, as the OpenAlex call in CUR-4089 did.
				if (String(url).includes("export.arxiv.org")) return new Promise<Response>(() => {});
				return Promise.resolve(okJson({}) as unknown as Response);
			})
		);
		const progress: WebProgress = { stage: "rewrite", pending: new Set() };
		const started = Date.now();
		const r = await Promise.race([
			retrieveWeb("what is a vector database", { perEngineTimeoutMs: 30, timeoutMs: 60, progress }),
			new Promise<"hung">((res) => setTimeout(() => res("hung"), 1000)),
		]);
		expect(r, "the fan-out returned").not.toBe("hung");
		expect(Date.now() - started).toBeLessThan(500);
		expect(progress.pending.size).toBe(0);
	});

	it("marks the leg done with nothing pending once it returns", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => okJson({}) as unknown as Response));
		const progress: WebProgress = { stage: "rewrite", pending: new Set() };
		await retrieveWeb("what is a vector database", { perEngineTimeoutMs: 200, progress });
		expect(progress.stage).toBe("done");
		expect(progress.pending.size).toBe(0);
	});
});

describe("the post-Firecrawl grace window (CUR-2121)", () => {
	const hangUntilAborted = (init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
			signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
				once: true,
			});
		});
	const stubFetch = (firecrawlHits: number) =>
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
				const u = String(url);
				if (u.includes("export.arxiv.org")) return hangUntilAborted(init);
				if (u.includes("api.firecrawl.dev"))
					return Promise.resolve(
						okJson({
							data: {
								web: Array.from({ length: firecrawlHits }, (_, i) => ({
									url: `https://example.com/${i}`,
									title: `Result ${i}`,
									description: "A page about vector databases.",
								})),
							},
						}) as unknown as Response
					);
				return Promise.reject(new Error(`unexpected fetch: ${u}`));
			})
		);
	const onlyFirecrawlAndArxiv = {
		firecrawl: 3,
		arxiv: 3,
		wikipedia: 0,
		wikinews: 0,
		openalex: 0,
		huggingface: 0,
		timeoutMs: 5000,
		perEngineTimeoutMs: 400,
		afterFirecrawlGraceMs: 30,
	};

	beforeEach(() => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		vi.mocked(logger.warn).mockClear();
	});

	// `cutEngines` names arXiv only when the grace timer fired and
	// aborted it; a broken grace window lets arXiv run to its own cap and log as a failed engine. An
	// elapsed bound stays for the one thing `cutEngines` can't see, a return that still waits after the
	// abort, with the cap raised to 3 s so the bound has room under load. (CUR-2756)
	it("cuts a slow engine with the grace window once Firecrawl returns results, and does not log the cut as a failure", async () => {
		stubFetch(2);
		const started = Date.now();
		const r = await retrieveWeb("what is a vector database", {
			...onlyFirecrawlAndArxiv,
			perEngineTimeoutMs: 3000,
		});
		const elapsed = Date.now() - started;

		expect(
			r.timings?.cutEngines,
			"arXiv was not cut by the grace window, so the fan-out waited for its own cap"
		).toEqual(["arxiv"]);
		expect(elapsed, "the fan-out still waited on something after the grace window cut arXiv").toBeLessThan(
			1500
		);
		expect(r.merged.some((s) => s.engine === "Firecrawl")).toBe(true);
		const failureLogs = vi
			.mocked(logger.warn)
			.mock.calls.filter((c) => String(c[1]).includes("engine failed"));
		expect(failureLogs).toEqual([]);
	});

	it("still logs an engine that fails for its own reason inside the grace window, rather than counting it as cut", async () => {
		stubFetch(2);
		const inner = vi.mocked(fetch).getMockImplementation()!;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
				String(url).includes("export.arxiv.org")
					? new Promise<Response>((_resolve, reject) =>
							setTimeout(() => reject(new TypeError("fetch failed")), 5)
						)
					: inner(url, init)
			)
		);
		const r = await retrieveWeb("what is a vector database", onlyFirecrawlAndArxiv);

		expect(r.timings?.cutEngines).toBeUndefined();
		const failureLogs = vi
			.mocked(logger.warn)
			.mock.calls.filter((c) => String(c[1]).includes("engine failed"));
		expect(failureLogs.map((c) => (c[0] as { engine: string }).engine)).toEqual(["arxiv"]);
	});

	// axiom-alert's search-refusals check counts these by the logged `status` field. (CUR-2597)
	it("logs a refusing engine's HTTP status on its engine-failed line", async () => {
		stubFetch(2);
		const inner = vi.mocked(fetch).getMockImplementation()!;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
				String(url).includes("export.arxiv.org")
					? Promise.resolve(new Response("slow down", { status: 429 }))
					: inner(url, init)
			)
		);
		await retrieveWeb("what is a vector database", onlyFirecrawlAndArxiv);

		const failureLogs = vi
			.mocked(logger.warn)
			.mock.calls.filter((c) => String(c[1]).includes("engine failed"));
		expect(failureLogs.map((c) => c[0] as { engine: string; status?: number })).toEqual([
			expect.objectContaining({ engine: "arxiv", status: 429 }),
		]);
	});

	it("leaves every engine to its own cap when Firecrawl returns nothing (fail toward waiting, not toward an empty turn)", async () => {
		stubFetch(0);
		const started = Date.now();
		const r = await retrieveWeb("what is a vector database", onlyFirecrawlAndArxiv);
		const elapsed = Date.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(350);
		expect(r.timings?.cutEngines).toBeUndefined();
	});
});

describe("source-credibility-filter (CUR-2423)", () => {
	const firecrawlHits = [
		{ url: "https://www.reddit.com/r/energy/comments/1", title: "Is nuclear safe?", description: "a forum thread" },
		{ url: "https://www.youtube.com/watch?v=1", title: "Kenya GDP explained", description: "a video" },
		{ url: "https://www.gov.uk/evicting-tenants", title: "Evicting tenants", description: "official guidance" },
	];
	const stubFirecrawl = () =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: RequestInfo | URL) =>
				String(url).includes("api.firecrawl.dev")
					? okJson({ data: { web: firecrawlHits } })
					: okJson({ query: { search: [] }, results: [] })
			)
		);

	it("off: forum and video pages reach the candidates, and no screen is reported", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		stubFirecrawl();
		const r = await retrieveWeb("nuclear power safety", { preShaped: true });
		expect(r.merged.map((s) => s.url)).toContain("https://www.reddit.com/r/energy/comments/1");
		expect(r.credibility).toBeUndefined();
	});

	it("on: forum and video pages are dropped before ranking and counted, and the survivor is labelled official under a thin-evidence note", async () => {
		configValues.FIRECRAWL_API_KEY = "test-key";
		flagsOn.add("source-credibility-filter");
		stubFirecrawl();
		const r = await retrieveWeb("nuclear power safety", { preShaped: true });
		expect(r.merged.map((s) => s.url)).toEqual(["https://www.gov.uk/evicting-tenants"]);
		expect(r.credibility).toEqual({ kept: 1, dropped: 2 });
		const { evidence } = numberWebSources(r.merged, 0, r.credibility);
		expect(evidence).toMatch(/^Note: only 1 source below passed the source screen/);
		expect(evidence).toContain("(Firecrawl, date unknown, official source)");
	});
});

describe("OpenAlex query text — OpenAlex 400s on ? and *, so both are stripped (CUR-3833)", () => {
	const sentSearch = async (query: string): Promise<string | null | undefined> => {
		const seen: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: RequestInfo | URL) => {
				seen.push(String(url));
				return Promise.resolve(new Response(JSON.stringify({ results: [] }), { status: 200 }));
			})
		);
		await retrieveWeb(query, {
			openalex: 1,
			wikipedia: 0,
			wikinews: 0,
			firecrawl: 0,
			huggingface: 0,
			arxiv: 0,
			perEngineTimeoutMs: 500,
		});
		const oa = seen.find((u) => u.includes("api.openalex.org"));
		return oa === undefined ? undefined : new URL(oa).searchParams.get("search");
	};
	it("strips the question mark from a question-shaped query", async () => {
		expect(await sentSearch("what is CRISPR?")).toBe("what is CRISPR");
	});
	it("strips wildcard asterisks and collapses the gap they leave", async () => {
		expect(await sentSearch("gene* editing  ?")).toBe("gene editing");
	});
	it("skips OpenAlex entirely for a query of only ? and *, rather than sending a request that 400s", async () => {
		expect(await sentSearch("??*")).toBeUndefined();
	});
});

describe("a latest question searches the past year and unfiltered together, recent first; FIRECRAWL_TBS wins (CUR-3932)", () => {
	const firecrawlBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
		fetchMock.mock.calls
			.filter((c) => String(c[0]).includes("api.firecrawl.dev/v2/search"))
			.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as { tbs?: string; query: string });
	const hit = (url: string) => ({ url, title: url, description: `about ${url}` });
	// The eclipse question as Firecrawl answers it: the past year leads with Aug 2026's
	// eclipse (not a US one); only the unfiltered search carries the Apr 2024 US answer.
	const stubFetch = (byTbs: Record<string, string[]> = {}, failTbs?: string) => {
		const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
			if (!String(url).includes("api.firecrawl.dev/v2/search"))
				return Promise.resolve((String(url).includes("export.arxiv.org") ? okText("") : okJson({})) as unknown as Response);
			const tbs = (JSON.parse(String(init?.body)) as { tbs?: string }).tbs ?? "none";
			if (tbs === failTbs) return Promise.reject(new Error("firecrawl down"));
			return Promise.resolve(okJson({ data: { web: (byTbs[tbs] ?? []).map(hit) } }) as unknown as Response);
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	};
	const eclipse = {
		"qdr:y": ["https://science.nasa.gov/eclipse-aug-12-2026", "https://en.wikipedia.org/wiki/Solar_eclipse_of_April_8,_2024"],
		none: ["https://en.wikipedia.org/wiki/List_of_solar_eclipses_visible_from_the_United_States", "https://en.wikipedia.org/wiki/Solar_eclipse_of_April_8,_2024"],
	};
	const firecrawlOnly = { perEngineTimeoutMs: 500, wikipedia: 0, wikinews: 0, openalex: 0, arxiv: 0, huggingface: 0 };
	beforeEach(() => {
		configValues.FIRECRAWL_API_KEY = "test-key";
	});

	it("runs a past-year and an unfiltered search for a latest question", async () => {
		const fetchMock = stubFetch(eclipse);
		await retrieveWeb("most recent total solar eclipse visible in the US", { ...firecrawlOnly, latest: true });
		expect(firecrawlBodies(fetchMock).map((b) => b.tbs).sort()).toEqual(["qdr:y", undefined].sort());
	});
	it("keeps the older right answer: past-year first at each rank, deduped by URL", async () => {
		stubFetch(eclipse);
		const r = await retrieveWeb("most recent total solar eclipse visible in the US", { ...firecrawlOnly, latest: true });
		expect(r.merged.map((c) => c.url)).toEqual(
			expect.arrayContaining([
				"https://science.nasa.gov/eclipse-aug-12-2026",
				"https://en.wikipedia.org/wiki/List_of_solar_eclipses_visible_from_the_United_States",
				"https://en.wikipedia.org/wiki/Solar_eclipse_of_April_8,_2024",
			])
		);
		expect(r.merged.filter((c) => c.url.includes("April_8,_2024"))).toHaveLength(1);
	});
	it("still answers from the unfiltered search when the past-year one fails", async () => {
		stubFetch(eclipse, "qdr:y");
		const r = await retrieveWeb("most recent total solar eclipse visible in the US", { ...firecrawlOnly, latest: true });
		expect(r.merged.map((c) => c.url)).toContain(
			"https://en.wikipedia.org/wiki/List_of_solar_eclipses_visible_from_the_United_States"
		);
	});
	it("sends one unfiltered search when the question does not ask for the latest", async () => {
		const fetchMock = stubFetch();
		await retrieveWeb("how the ECB sets rates", { ...firecrawlOnly, latest: false });
		expect(firecrawlBodies(fetchMock).map((b) => b.tbs)).toEqual([undefined]);
	});
	it("sends FIRECRAWL_TBS on one search per call when it is set, latest or not", async () => {
		configValues.FIRECRAWL_TBS = "sbd:1,qdr:m";
		const fetchMock = stubFetch();
		await retrieveWeb("how the ECB sets rates", { ...firecrawlOnly, latest: false });
		await retrieveWeb("ECB most recent rate decision", { ...firecrawlOnly, latest: true });
		expect(firecrawlBodies(fetchMock).map((b) => b.tbs)).toEqual(["sbd:1,qdr:m", "sbd:1,qdr:m"]);
	});
});

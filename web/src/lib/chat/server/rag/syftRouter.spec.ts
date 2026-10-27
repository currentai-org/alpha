import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Hermetic: mock the served-model fetch + config + env + the primary-model + logger. providerPin and
// firstKey are pure-ish (config-backed) and run for real against the mocked config.
const h = vi.hoisted(() => ({
	cfg: {} as Record<string, string>,
	router: {} as Record<string, unknown>,
	primary: { v: "model-a" as string | undefined },
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	embedText: vi.fn(),
}));

vi.mock("$lib/chat/server/config", () => ({ config: h.cfg }));
vi.mock("./env", () => ({ syftRouter: () => h.router }));
vi.mock("$lib/chat/server/primaryModel", () => ({ primaryModelId: () => h.primary.v }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn: h.loggerWarn, info: h.loggerInfo, error: vi.fn(), debug: vi.fn() },
}));
// Embedding lane for the semantic decision cache — embedText mocked (default: resolves undefined ⇒
// the semantic path silently abstains, so every pre-existing test is byte-for-byte unchanged);
// cosine is the real formula (pure math) so similarity thresholds behave exactly as in prod.
vi.mock("./embed", () => ({
	embedText: (...args: unknown[]) => h.embedText(...args),
	cosine: (a: number[], b: number[]) => {
		let dot = 0;
		let na = 0;
		let nb = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			na += a[i] * a[i];
			nb += b[i] * b[i];
		}
		return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
	},
}));

import { routeEndpoints, logRouterShadow, _resetRouterCache } from "./syftRouter";
import type { CatalogEntry } from "./syftCatalog";

const fetchMock = vi.fn();

const entry = (path: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
	path,
	name: path,
	description: "",
	tags: [],
	metered: false,
	...over,
});
const catalog: CatalogEntry[] = [entry("a/x"), entry("b/y"), entry("c/z", { metered: true })];

const modelReply = (content: string, status = 200) =>
	new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
// A raw error body (plain text, not the chat envelope) for non-2xx responses.
const errorReply = (body: string, status: number) => new Response(body, { status });
const endpointsJson = (paths: string[]) => JSON.stringify({ endpoints: paths });

beforeEach(() => {
	vi.clearAllMocks();
	_resetRouterCache();
	vi.stubGlobal("fetch", fetchMock);
	for (const k of Object.keys(h.cfg)) delete h.cfg[k];
	Object.assign(h.cfg, {
		OPENAI_BASE_URL: "https://router.huggingface.co/v1",
		OPENAI_API_KEY: "hf_router",
		OPENAI_PROVIDER: "publicai",
		HF_BILL_TO: "current-ai-official",
	});
	for (const k of Object.keys(h.router)) delete h.router[k];
	Object.assign(h.router, { model: "", maxEndpoints: 3, catalogTtlMs: 3600000 });
	h.primary.v = "model-a";
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("routeEndpoints — config + request shape", () => {
	it("undecided (no fetch) when the catalog is empty", async () => {
		expect(await routeEndpoints("q", [])).toEqual({ kind: "undecided" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("undecided when serving config is incomplete (no base url / key / model)", async () => {
		h.cfg.OPENAI_BASE_URL = "";
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
		h.cfg.OPENAI_BASE_URL = "https://router.huggingface.co/v1";
		h.cfg.OPENAI_API_KEY = "";
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
		h.cfg.OPENAI_API_KEY = "hf_router";
		h.primary.v = undefined; // no RAG_ROUTER_MODEL and no allowlist
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts the provider-pinned model + JSON-Lines catalog + json_object format", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("photonics in Lausanne", catalog);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.huggingface.co/v1/chat/completions");
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe("model-a:publicai"); // provider-pinned via resolveProviderModelId
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.stream).toBe(false);
		expect((init.headers as Record<string, string>)["User-Agent"]).toBe("aipotluck.org");
		// Server-side call → must bill to a configured org or the HF router 403s the routing call.
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBe("current-ai-official");
		// Catalog serialized as JSON Lines (one object per line), not dash-delimited prose.
		const userMsg = body.messages[1].content as string;
		expect(userMsg).toContain('{"path":"a/x"');
		expect(userMsg).toContain("CATALOG");
	});

	it("omits X-HF-Bill-To when no bill-to org is configured (non-HF bases keep working)", async () => {
		delete h.cfg.HF_BILL_TO;
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBeUndefined();
	});

	it("prefers RAG_ROUTER_BILL_TO over HF_BILL_TO for the routing call", async () => {
		h.cfg.RAG_ROUTER_BILL_TO = "router-org";
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBe("router-org");
	});

	it("drops X-HF-Bill-To on a non-HF base (e.g. CSCS) even when an org is configured", async () => {
		// X-HF-Bill-To is an HF Inference-Providers concept; on CSCS the main chat path omits it, so the
		// router must too. It's the router's ONE request-shape divergence from the known-good main path.
		h.cfg.OPENAI_BASE_URL = "https://api.swissai.svc.cscs.ch/v1";
		h.cfg.RAG_ROUTER_BILL_TO = "router-org"; // configured, but must NOT be sent to a non-HF host
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBeUndefined();
	});

	it("still sends X-HF-Bill-To on HF hosts carrying a port or trailing dot", async () => {
		// hostname-based match (not host) + trailing-dot strip: these are the HF router, so the 403-avoiding
		// bill-to header MUST survive a non-default port and a FQDN trailing dot.
		for (const base of [
			"https://router.huggingface.co:8443/v1",
			"https://router.huggingface.co./v1",
		]) {
			fetchMock.mockReset();
			_resetRouterCache();
			h.cfg.OPENAI_BASE_URL = base;
			fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
			await routeEndpoints("q", catalog);
			const init = fetchMock.mock.calls[0][1] as RequestInit;
			expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBe("current-ai-official");
		}
	});

	it("uses RAG_ROUTER_MODEL when set, else the primary model", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		h.router.model = "custom/model";
		await routeEndpoints("q", catalog);
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.model).toBe("custom/model:publicai");
	});
});

describe("routeEndpoints — dedicated router lane (RAG_ROUTER_BASE_URL/_API_KEY/_PROVIDER)", () => {
	it("routes on the override lane, decoupled from a cold non-HF main (CSCS) served model", async () => {
		// The main chat serves Apertus from CSCS (scale-to-zero), so the router, as the turn's
		// first upstream hit, would eat a cold 503. Point the ROUTER at the always-warm HF router lane instead.
		h.cfg.OPENAI_BASE_URL = "https://api.swissai.svc.cscs.ch/v1"; // cold main lane
		h.cfg.OPENAI_API_KEY = "sk-cscs"; // a CSCS key — INVALID on HF, must not be used for routing
		h.cfg.OPENAI_PROVIDER = "publicai";
		h.router.baseUrl = "https://router.huggingface.co/v1";
		h.router.apiKey = "hf_router_lane";
		h.router.provider = "publicai";
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		const d = await routeEndpoints("q", catalog);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.huggingface.co/v1/chat/completions"); // warm HF lane, not CSCS
		const headers = init.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer hf_router_lane"); // dedicated key, not the CSCS sk-
		// The override base is the HF router ⇒ X-HF-Bill-To is (correctly) sent again on this lane.
		expect(headers["X-HF-Bill-To"]).toBe("current-ai-official");
		expect(JSON.parse(init.body as string).model).toBe("model-a:publicai");
		expect(d.kind).toBe("picks");
	});

	it("RAG_ROUTER_API_KEY wins over the main OPENAI_API_KEY chain for the bearer", async () => {
		h.cfg.OPENAI_API_KEY = "hf_main";
		h.router.apiKey = "hf_dedicated";
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer hf_dedicated");
	});

	it("RAG_ROUTER_PROVIDER overrides the main OPENAI_PROVIDER pin", async () => {
		h.cfg.OPENAI_PROVIDER = "publicai";
		h.router.provider = "featherless";
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		expect(body.model).toBe("model-a:featherless");
	});

	it("bill-to follows the OVERRIDDEN host: a CSCS router override drops X-HF-Bill-To even when main is HF", async () => {
		// isHfRouter must test the RESOLVED (overridden) base, not the main one — else a CSCS router
		// lane would carry the meaningless HF billing header.
		h.cfg.OPENAI_BASE_URL = "https://router.huggingface.co/v1"; // main is HF...
		h.router.baseUrl = "https://api.swissai.svc.cscs.ch/v1"; // ...but the router lane is CSCS
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.swissai.svc.cscs.ch/v1/chat/completions");
		expect((init.headers as Record<string, string>)["X-HF-Bill-To"]).toBeUndefined();
	});

	it("unset overrides ⇒ byte-for-byte the main OPENAI_* lane (no regression)", async () => {
		// No h.router.baseUrl/apiKey/provider set (the default mock) → the main OPENAI_* values drive.
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q", catalog);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.huggingface.co/v1/chat/completions");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer hf_router");
		expect(JSON.parse(init.body as string).model).toBe("model-a:publicai");
	});

	it("HF lane with RAG_ROUTER_API_KEY unset ⇒ falls back to HF_RAG_EMBEDDINGS_TOKEN, not the CSCS key", async () => {
		// A separate RAG_ROUTER_API_KEY is not required. On the HF router lane the router reuses
		// the embeddings path's dedicated org token (HF_RAG_EMBEDDINGS_TOKEN); the CSCS sk-… OPENAI_API_KEY
		// is last in the chain (invalid on HF) so it can never hijack the bearer here.
		h.cfg.OPENAI_BASE_URL = "https://api.swissai.svc.cscs.ch/v1"; // cold CSCS main lane
		h.cfg.OPENAI_API_KEY = "sk-cscs"; // CSCS key — invalid on HF, must NOT be used for routing
		h.cfg.HF_RAG_EMBEDDINGS_TOKEN = "hf_rag_org";
		h.router.baseUrl = "https://router.huggingface.co/v1"; // route on the warm HF lane
		// h.router.apiKey intentionally unset — the whole point of the fallback
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer hf_rag_org");
	});

	it("non-HF (CSCS) lane ⇒ a set HF_RAG_EMBEDDINGS_TOKEN is ignored; the main key drives (no regression)", async () => {
		// The HF-token fallback is GATED to the HF lane (like X-HF-Bill-To). On a CSCS lane the CSCS key is
		// correct, so a set HF_RAG_EMBEDDINGS_TOKEN must not hijack the bearer — else CSCS routing would 401.
		h.cfg.OPENAI_BASE_URL = "https://api.swissai.svc.cscs.ch/v1";
		h.cfg.OPENAI_API_KEY = "sk-cscs";
		h.cfg.HF_RAG_EMBEDDINGS_TOKEN = "hf_rag_org"; // set, but must be ignored on a non-HF lane
		// no router base override → baseURL resolves to the CSCS main lane
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		await routeEndpoints("q", catalog);
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-cscs");
	});
});

describe("routeEndpoints — validation", () => {
	it("keeps only scoped-catalog paths, scores 1.0, names from catalog", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		const d = await routeEndpoints("q", catalog);
		expect(d).toEqual({ kind: "picks", picks: [{ path: "a/x", name: "a/x", score: 1 }] });
	});

	it("drops hallucinated paths but keeps the valid ones (mixed)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x", "ghost/none", "b/y"])));
		const d = await routeEndpoints("q", catalog);
		expect(d.kind).toBe("picks");
		expect(d.kind === "picks" && d.picks.map((p) => p.path)).toEqual(["a/x", "b/y"]);
	});

	it("all-hallucinated non-empty array → undecided (malfunction, not confident-none)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["ghost/none", "nope/zip"])));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("empty array → confident empty", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "empty" });
	});

	it("de-dups and caps to RAG_ROUTER_MAX_ENDPOINTS", async () => {
		h.router.maxEndpoints = 2;
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x", "a/x", "b/y", "c/z"])));
		const d = await routeEndpoints("q", catalog);
		expect(d.kind === "picks" && d.picks.map((p) => p.path)).toEqual(["a/x", "b/y"]);
	});

	it("non-JSON / wrong-shape output → undecided", async () => {
		fetchMock.mockResolvedValue(modelReply("not json at all"));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
		_resetRouterCache();
		fetchMock.mockResolvedValue(modelReply(JSON.stringify({ notEndpoints: 1 })));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("parses a ```json fenced reply (a model that ignores response_format)", async () => {
		fetchMock.mockResolvedValue(modelReply('```json\n{"endpoints": ["a/x"]}\n```'));
		const d = await routeEndpoints("q", catalog);
		expect(d.kind === "picks" && d.picks.map((p) => p.path)).toEqual(["a/x"]);
	});

	it("does NOT scrape a `{…}` object out of free prose (no injection-echo picks)", async () => {
		// A model that echoes an injected/quoted JSON object mid-sentence must NOT be treated as an
		// intentional answer — only strict whole-response JSON or a WHOLE-response fenced block counts.
		fetchMock.mockResolvedValue(
			modelReply('Sure! Here are the endpoints: {"endpoints": ["c/z"]} — hope that helps.')
		);
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("does NOT accept a fenced block embedded in prose (only a WHOLE-response fence counts)", async () => {
		// An echoed ```json block surrounded by explanatory text must not be parsed as the answer.
		fetchMock.mockResolvedValue(
			modelReply('The user supplied:\n```json\n{"endpoints":["c/z"]}\n```\nFinal answer: none.')
		);
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("logs dropped + metered-selected counts (no query, no descriptions)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["c/z", "ghost/none"])));
		await routeEndpoints("q", catalog);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ dropped: 1, meteredSelected: 1, picked: 1 }),
			expect.any(String)
		);
	});
});

describe("routeEndpoints — decision/outcome logging (enabled-mode observability)", () => {
	it("logs the decision with httpStatus + baseHost + counts on a successful pick", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q", catalog);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "picks",
				httpStatus: 200,
				baseHost: "router.huggingface.co",
				picked: 1,
				catalog: catalog.length,
			}),
			"[rag] SyftHub router decision"
		);
	});

	it("logs the non-2xx httpStatus on a failed routing call (the endpoint/auth-mismatch signal)", async () => {
		fetchMock.mockResolvedValue(modelReply("nope", 404));
		await routeEndpoints("q", catalog);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "undecided", httpStatus: 404 }),
			"[rag] SyftHub router decision"
		);
	});

	it("logs httpStatus null when the fetch itself throws (abort/network)", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
		await routeEndpoints("q", catalog);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "undecided", httpStatus: null }),
			"[rag] SyftHub router decision"
		);
	});

	it("warns (does not silently fall through) when served-model config is incomplete", async () => {
		h.cfg.OPENAI_BASE_URL = "";
		await routeEndpoints("q", catalog);
		expect(h.loggerWarn).toHaveBeenCalledWith(
			expect.objectContaining({ hasBase: false }),
			"[rag] SyftHub router skipped — incomplete served-model config"
		);
	});
});

describe("routeEndpoints — failure modes", () => {
	it("fetch rejection (network/abort) → undecided", async () => {
		fetchMock.mockRejectedValue(new Error("network"));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("non-2xx → undecided", async () => {
		fetchMock.mockResolvedValue(modelReply("{}", 500));
		expect(await routeEndpoints("q", catalog)).toEqual({ kind: "undecided" });
	});

	it("already-aborted signal → undecided without fetching", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		expect(await routeEndpoints("q", catalog, ctrl.signal)).toEqual({ kind: "undecided" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("already-aborted signal yields undecided even with a WARM cache (abort checked before cache read)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("warm-then-abort", catalog); // caches picks for this query
		const ctrl = new AbortController();
		ctrl.abort();
		const d = await routeEndpoints("warm-then-abort", catalog, ctrl.signal);
		expect(d).toEqual({ kind: "undecided" }); // NOT the cached picks
	});

	it("soft-cap abort DURING the fetch → undecided and NOT cached (body arrived after the race gave up)", async () => {
		const ctrl = new AbortController();
		// fetch ignores the abort and still resolves a valid body, but the signal is aborted meanwhile.
		fetchMock.mockImplementation(() => {
			ctrl.abort();
			return Promise.resolve(modelReply(endpointsJson(["a/x"])));
		});
		const d = await routeEndpoints("q-abort-mid", catalog, ctrl.signal);
		expect(d).toEqual({ kind: "undecided" });
		// Not cached: a fresh un-aborted call re-fetches (would have been a cache hit if we'd cached it).
		fetchMock.mockReset();
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q-abort-mid", catalog);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("response_format 400 → retries ONCE without it, then succeeds", async () => {
		fetchMock
			.mockResolvedValueOnce(modelReply("rejected", 400))
			.mockResolvedValueOnce(modelReply(endpointsJson(["a/x"])));
		const d = await routeEndpoints("q", catalog);
		expect(d.kind).toBe("picks");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
		expect(retryBody.response_format).toBeUndefined(); // retry omits it
	});

	it("5xx on the json_object request → retries WITHOUT response_format (CSCS 503 case), then succeeds + logs degraded", async () => {
		fetchMock
			.mockResolvedValueOnce(errorReply("response_format unsupported", 503))
			.mockResolvedValueOnce(modelReply(endpointsJson(["a/x"])));
		const d = await routeEndpoints("q", catalog);
		expect(d.kind).toBe("picks");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
		expect(retryBody.response_format).toBeUndefined();
		// degraded:true makes a recovered response_format incompatibility distinguishable from a
		// plain success in the logs.
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "picks", httpStatus: 200, degraded: true }),
			"[rag] SyftHub router decision"
		);
	});

	it("does NOT retry an auth/route failure (404) — a second identical call won't help", async () => {
		fetchMock.mockResolvedValue(errorReply("not found", 404));
		await routeEndpoints("q", catalog);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("logs a SAFE classified reason on a persistent non-2xx — never the raw body (§7)", async () => {
		fetchMock.mockResolvedValue(errorReply("SECRET-PROMPT-ECHO: model is currently loading", 503));
		await routeEndpoints("q", catalog);
		const logged = h.loggerInfo.mock.calls.find(
			(c) => c[1] === "[rag] SyftHub router decision"
		)?.[0];
		expect(logged).toMatchObject({ kind: "undecided", httpStatus: 503, reason: "unavailable" });
		// The raw upstream body must NOT appear anywhere in the logged payload.
		expect(JSON.stringify(logged)).not.toContain("SECRET-PROMPT-ECHO");
	});

	it("classifies a response_format rejection so the CSCS hypothesis is confirmable from logs", async () => {
		fetchMock.mockResolvedValue(errorReply("invalid request: response_format not supported", 400));
		await routeEndpoints("q", catalog);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "response-format-rejected" }),
			"[rag] SyftHub router decision"
		);
	});
});

describe("routeEndpoints — decision cache", () => {
	it("caches picks/empty (no second fetch); never caches undecided", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("same-q", catalog);
		await routeEndpoints("same-q", catalog);
		expect(fetchMock).toHaveBeenCalledTimes(1); // served from cache

		// undecided is never cached → re-runs the fetch.
		_resetRouterCache();
		fetchMock.mockClear();
		fetchMock.mockRejectedValue(new Error("boom"));
		await routeEndpoints("err-q", catalog);
		await routeEndpoints("err-q", catalog);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("re-validates cached picks against the current catalog; all-absent → undecided", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q-revalidate", catalog); // caches pick a/x
		fetchMock.mockClear();
		// Same query + model but a catalog WITHOUT a/x → different fingerprint AND the path is absent.
		const shrunk = [entry("b/y")];
		const d = await routeEndpoints("q-revalidate", shrunk);
		// New fingerprint ⇒ cache miss ⇒ a fresh fetch; mock still returns a/x (absent here) → undecided.
		expect(fetchMock).toHaveBeenCalled();
		expect(d).toEqual({ kind: "undecided" });
	});

	it("a description change reshapes the fingerprint and forces a fresh decision", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q-fp", catalog);
		fetchMock.mockClear();
		const changed = catalog.map((e) =>
			e.path === "a/x" ? { ...e, description: "now different" } : e
		);
		await routeEndpoints("q-fp", changed);
		expect(fetchMock).toHaveBeenCalled(); // not served from the stale-fingerprint cache
	});

	it("a provider change resolves a different model id → cache miss (keyed on the resolved model)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q-prov", catalog);
		fetchMock.mockClear();
		h.cfg.OPENAI_PROVIDER = "other-lane"; // model-a:publicai → model-a:other-lane
		await routeEndpoints("q-prov", catalog);
		expect(fetchMock).toHaveBeenCalled(); // a decision from a different lane is not reused
	});
});

describe("routeEndpoints — query cap (security)", () => {
	it("caps an oversized user query in the prompt (and keeps it out of the cache key)", async () => {
		fetchMock.mockResolvedValue(modelReply(endpointsJson([])));
		const huge = "x".repeat(10000);
		await routeEndpoints(huge, catalog);
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
		const userMsg = body.messages[1].content as string;
		// The 2000-char cap means a 2100-run of the query char can never appear verbatim in the prompt.
		expect(userMsg).not.toContain("x".repeat(2100));
		expect(userMsg).toContain("CATALOG"); // catalog still serialized
	});
});

describe("logRouterShadow", () => {
	it("logs routed vs embedding paths + a query DIGEST/length, never the raw query text", () => {
		const query = "a fairly long user question about photonics in Lausanne";
		logRouterShadow(query, { kind: "empty" }, [{ path: "e/y", name: "Y", score: 0.8 }]);
		expect(h.loggerInfo).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "empty",
				routed: [],
				embedding: ["e/y"],
				qLen: query.length,
				qHash: expect.any(String),
			}),
			expect.any(String)
		);
		// The raw query must NOT appear anywhere in the logged payload.
		const logged = JSON.stringify(h.loggerInfo.mock.calls[0][0]);
		expect(logged).not.toContain("photonics");
	});
});

describe("routeEndpoints — semantic decision cache (paraphrase reuse)", () => {
	const vecFor = (impls: Record<string, number[]>) =>
		h.embedText.mockImplementation(async (text: string) => impls[text] ?? null);

	beforeEach(() => {
		Object.assign(h.router, { semCache: true, semCacheMin: 0.9 });
	});

	it("a paraphrase (cosine ≥ floor) reuses the cached decision — the LLM runs ONCE", async () => {
		// Two rewordings that miss the exact-match key but sit at cosine ≈ 0.98.
		vecFor({ "what does epfl publish": [1, 0], "epfl publications": [0.98, 0.199] });
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		const d1 = await routeEndpoints("what does EPFL publish", catalog);
		expect(d1).toEqual({ kind: "picks", picks: [expect.objectContaining({ path: "a/x" })] });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const d2 = await routeEndpoints("EPFL publications", catalog);
		expect(d2).toEqual({ kind: "picks", picks: [expect.objectContaining({ path: "a/x" })] });
		expect(fetchMock).toHaveBeenCalledTimes(1); // semantic hit — no second LLM call
	});

	it("a DIFFERENT query (cosine < floor) still routes via the LLM", async () => {
		vecFor({ "what does epfl publish": [1, 0], "swiss weather data": [0.2, 0.98] });
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("what does EPFL publish", catalog);
		await routeEndpoints("swiss weather data", catalog);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("kill switch (semCache=false) → the embedding lane is never touched", async () => {
		h.router.semCache = false;
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("q", catalog);
		expect(h.embedText).not.toHaveBeenCalled();
	});

	it("a failed embedding abstains (fail-open) — the LLM routes as always", async () => {
		h.embedText.mockRejectedValue(new Error("embed lane down"));
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		const d = await routeEndpoints("q", catalog);
		expect(d).toEqual({ kind: "picks", picks: [expect.objectContaining({ path: "a/x" })] });
	});

	it("a semantic hit whose paths vanished from the catalog falls through to the LLM (revive guard)", async () => {
		vecFor({ "query one": [1, 0], "query two": [0.98, 0.199] });
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("query one", catalog);
		// The catalog was rebuilt without a/x — the cached decision revives to undecided ⇒ fresh LLM call.
		await routeEndpoints("query two", [entry("b/y")]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("decisions are scoped: a different catalog fingerprint never reuses the vector match", async () => {
		vecFor({ "query one": [1, 0], "query one b": [0.99, 0.14] });
		fetchMock.mockImplementation(async () => modelReply(endpointsJson(["a/x"])));
		await routeEndpoints("query one", catalog);
		// Same-ish vector, but a catalog with different DESCRIPTIONS (new fingerprint + a/x still present).
		const changed = [entry("a/x", { description: "rewritten" }), entry("b/y")];
		await routeEndpoints("query one b", changed);
		expect(fetchMock).toHaveBeenCalledTimes(2); // scope mismatch ⇒ no semantic reuse
	});
});

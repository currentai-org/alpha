import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ObjectId } from "bson";

// The sovereign-compute assertion logs; the log IS the product here, so the spy is the assertion.
const warn = vi.fn();
const info = vi.fn();
const errorLog = vi.fn();
// These specs stand a loopback server in for the user's endpoint, so the hosted-deployment SSRF guard
// would refuse it; pass through to plain fetch. localEndpointFetch.spec.ts covers the guard itself.
vi.mock("$lib/chat/server/localEndpointFetch", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/localEndpointFetch")>()),
	localEndpointFetch: (url: string | URL | Request, init?: RequestInit) => fetch(url, init),
}));

vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn, info, error: errorLog, debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

// An Apertus answer goes out native-first (CUR-1886, its kill switch retired in CUR-2853): the
// role-shaped request, then the flattened one (CUR-1294) if that fails. Each shape retries a
// substitution once on its own, so a shed Apertus answer sends 4 requests, two per shape.
vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

// The router's Mistral version check reads La Plateforme's alias list; each test sets the verdict. (CUR-2928)
const isSameMistralModel = vi.fn(async (_upstream: string, _pinned: string): Promise<boolean | undefined> => true);
vi.mock("$lib/chat/server/mistralVersions", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/mistralVersions")>()),
	isSameMistralModel,
}));

const { endpointOai } = await import("./endpointOai");
const { answersNativeFirst } = await import("./calculateTool");
const { config } = await import("$lib/chat/server/config");
const { MessageTooLongError } = await import("./fitHistory");

const GATEWAY = "https://api-internal.publicai.co/v1";
const CSCS = "https://api.inference.cscs.ch/v1";
// The real host the second-opinion panel's Olmo/EuroLLM calls land on, and the reason the assertion
// takes `servesUserAnswer` at all.
const OFF_ALLOWLIST = "https://api-internal-intel.publicai.co/olmo/v1";

/** A minimal chat-completions SSE body the openai SDK will parse to completion. */
function sseBody(model = "swiss-ai/apertus-v1.5-70b-thinking", provider?: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({
			id: "c1",
			object: "chat.completion.chunk",
			created: 0,
			model,
			...(provider ? { provider } : {}),
			choices: [{ index: 0, delta, finish_reason: finish }],
		})}\n\n`;
	return chunk({ role: "assistant", content: "hi" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

/** A plain 200 SSE response with NONE of the litellm/router headers — what a real local Ollama-style
 *  OpenAI-compatible server actually sends. Returns the request init each fetch() call was made with. */
function stubPlainServer() {
	const seen: RequestInit[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response(sseBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
		})
	);
	return seen;
}

/** Stub the GLOBAL fetch — endpointOai's customFetch wraps it, and it is customFetch that reads the
 *  request header and the LiteLLM response header. Returns the request init it was called with. */
function stubGatewayServing(backend: string, group = "swiss-ai/apertus-v1.5-70b-thinking") {
	return stubGatewaySequence([{ backend, group }]);
}

/** Same as stubGatewayServing, but each successive fetch() call returns the NEXT entry in `sequence`
 *  (clamped to the last one once exhausted) — for asserting what customFetch's own retry loop does
 *  across attempts, not just what a single response produces. */
function stubGatewaySequence(
	sequence: Array<{ backend: string; group?: string; bodyModel?: string; bodyProvider?: string }>
) {
	const seen: RequestInit[] = [];
	let call = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			seen.push(init ?? {});
			const { backend, group = "swiss-ai/apertus-v1.5-70b-thinking", bodyModel, bodyProvider } =
				sequence[Math.min(call, sequence.length - 1)];
			call++;
			return new Response(sseBody(bodyModel, bodyProvider), {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-litellm-model-api-base": backend,
					"x-litellm-model-group": group,
				},
			});
		})
	);
	return seen;
}

async function runTurnAgainst(seen: RequestInit[], params: { servesUserAnswer?: boolean }) {
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: GATEWAY,
		apiKey: "sk-test",
		model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
	});
	const stream = await endpoint({
		messages: [{ from: "user", content: "hi" }],
		locals: undefined,
		...params,
	} as Parameters<typeof endpoint>[0]);
	let routerMetadata: { model?: string; backend?: string; provider?: string } | undefined;
	for await (const chunk of stream) {
		if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
	}
	return { seen, routerMetadata };
}

async function runTurn(backend: string, params: { servesUserAnswer?: boolean }, group?: string) {
	return runTurnAgainst(stubGatewayServing(backend, group), params);
}

/** Drives a turn through a SEQUENCE of per-attempt backends — the shape the retry loop cares about. */
async function runTurnSequence(
	sequence: Array<{ backend: string; group?: string; bodyModel?: string; bodyProvider?: string }>,
	params: { servesUserAnswer?: boolean }
) {
	return runTurnAgainst(stubGatewaySequence(sequence), params);
}

/** Same as runTurnSequence, but for the CUR-1313 shed path: exhausted-and-still-substituted returns a
 *  503 Response, which the openai SDK turns into a thrown APIError at the `endpoint(...)` call itself
 *  — before any stream exists to iterate. Asserts the throw and returns `seen` for the caller's own
 *  assertions on attempt count. */
async function runTurnSequenceExpectingShed(
	sequence: Array<{ backend: string; group?: string; bodyModel?: string }>,
	params: { servesUserAnswer?: boolean } = { servesUserAnswer: true }
) {
	const seen = stubGatewaySequence(sequence);
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: GATEWAY,
		apiKey: "sk-test",
		model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
	});
	await expect(
		endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			...params,
		} as Parameters<typeof endpoint>[0])
	).rejects.toMatchObject({ status: 503 });
	return { seen };
}

beforeEach(() => {
	warn.mockClear();
	info.mockClear();
	errorLog.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("the sovereign-compute assertion on the LiteLLM backend", () => {
	it("warns when the USER'S ANSWER is served outside the Swiss allowlist", async () => {
		await runTurn(OFF_ALLOWLIST, { servesUserAnswer: true });

		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, msg] = warn.mock.calls[0];
		expect(msg).toMatch(/sovereign-compute copy is false/);
		expect(fields).toMatchObject({ backend: OFF_ALLOWLIST, swissBackend: false, servesUserAnswer: true });
	});

	it("stays quiet for a SIDE-CALL on the same non-Swiss backend", async () => {
		// The false positive the flag exists to prevent. `generateFromDefaultEndpoint` — titles, the
		// search decision, the query rewrite, the world-model verifier, the second-opinion panel —
		// never sets servesUserAnswer, and the panel routes to Olmo/EuroLLM on purpose. The turn's
		// answer still came from Switzerland, so there is nothing to warn about.
		await runTurn(OFF_ALLOWLIST, {});

		expect(warn).not.toHaveBeenCalled();
		// Still RECORDED, though — the route is a fact worth having in Axiom either way.
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ backend: OFF_ALLOWLIST, servesUserAnswer: false }),
			expect.stringContaining("litellm route")
		);
	});

	it("stays quiet for an answer served from Switzerland", async () => {
		await runTurn(CSCS, { servesUserAnswer: true });

		expect(warn).not.toHaveBeenCalled();
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ backend: CSCS, swissBackend: true, servesUserAnswer: true }),
			expect.anything()
		);
	});

	// The last hop, and the only one with no runtime seam: whether the ANSWER path actually sets the
	// flag. `servesUserAnswer` is optional on EndpointParameters — it has to be, since every side-call
	// omits it — so deleting the line from generate.ts type-checks, passes every test above, and
	// silently retires the assertion forever. Read from source for the same reason manifest.spec.ts
	// does: the fact is textual and there is nothing else that can hold it.
	it("is set by the answer path and by nothing else", async () => {
		const read = async (p: string) =>
			(await import("node:fs/promises")).readFile(new URL(p, import.meta.url), "utf8");

		// generateImpl's endpoint({...}) call — the one generation a user reads.
		expect(await read("../../textGeneration/generate.ts")).toMatch(/servesUserAnswer:\s*true/);
		// The side-call helper: titles, search decision, query rewrite, world model, second opinion.
		// It forwards a fixed field list, so the flag can only appear here deliberately.
		expect(await read("../../generateFromDefaultEndpoint.ts")).not.toMatch(/servesUserAnswer/);
	});

	it("puts the answer marker on the REQUEST, not in a shared closure", async () => {
		// Asserted on the outbound header because that is the part concurrency can break. customFetch
		// is built once per endpoint and shared by every call through it, so reading this from a
		// factory-scoped variable would let one request's answer be judged by another's flag. If this
		// header stops being sent, the assertion above silently never fires again.
		const { seen } = await runTurn(CSCS, { servesUserAnswer: true });
		const sent = new Headers(seen.at(-1)?.headers);
		expect(sent.get("ChatUI-Serves-User-Answer")).toBe("1");
	});
});

describe("CUR-1313: the retry fires on a MODEL SUBSTITUTION, not on backend location", () => {
	it("does NOT retry a backend-only mismatch — Featherless is the accepted lane, not a violation", async () => {
		// Same requested model on the one stubbed response, non-Swiss backend: a correct answer, not a
		// substitution, so no retry fires (CUR-1313).
		const { seen } = await runTurnSequence([{ backend: OFF_ALLOWLIST }], { servesUserAnswer: true });

		expect(seen).toHaveLength(1); // no retry spent on a healthy, merely non-Swiss, answer
		expect(warn).toHaveBeenCalledTimes(1); // still warns — the copy question is real, just not a retry trigger
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ backend: OFF_ALLOWLIST, substituted: false, retried: false }),
			expect.stringContaining("sovereign-compute copy is false")
		);
	});

	it("recovers silently when the retry lands back on the requested model — one info, no warn", async () => {
		const { seen, routerMetadata } = await runTurnSequence(
			[
				{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
				{ backend: CSCS }, // default group === requested — the substitution cleared
			],
			{ servesUserAnswer: true }
		);

		expect(seen).toHaveLength(2); // one retry, not a failover chain
		expect(warn).not.toHaveBeenCalled();
		// `info` is shared across this whole call (openAIChatToTextGenerationStream logs its own,
		// unrelated info line every turn) — filter to THIS call site's own message, as the existing
		// tests above do with toHaveBeenCalledWith rather than a raw total.
		const servingInfoCalls = info.mock.calls.filter(([, msg]) => String(msg).includes("litellm route"));
		expect(servingInfoCalls).toHaveLength(1);
		expect(servingInfoCalls[0][0]).toMatchObject({
			backend: CSCS,
			swissBackend: true,
			substituted: false,
			retried: true,
		});
		expect(routerMetadata?.backend).toBe(CSCS);
	});

	it("stops at the bound and SHEDS rather than serve the substitute, when every attempt substitutes", async () => {
		const { seen } = await runTurnSequenceExpectingShed([
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
		]);

		// Bounded at 2 attempts per shape even though the stub could serve more — this is the assertion
		// that a bad gateway can't turn one turn into an unbounded retry loop.
		expect(seen).toHaveLength(4); // two shapes, native then flattened, each bounded at one retry
		expect(warn).not.toHaveBeenCalled(); // this is a substitution shed, not a copy warn
		const shedCalls = errorLog.mock.calls.filter(([, msg]) => String(msg).includes("retries were exhausted"));
		expect(shedCalls).toHaveLength(2); // one shed per shape
		expect(shedCalls[0][0]).toMatchObject({
			group: "aisingapore/Qwen-SEA-LION-v4-32B-IT",
			substituted: true,
			retried: true,
		});
	});

	it("sheds a healthy gateway answer under the wrong_model_served fault, and never sends the fault header upstream (CUR-1614)", async () => {
		// Headers and body both name Apertus, as on a healthy turn. The fault rewrites the body only, so the
		// shed below can only come from the body check reading the swap.
		const { seen } = await runTurnSequenceExpectingShed([{ backend: CSCS }], {
			servesUserAnswer: true,
			substituteServedModel: "aisingapore/Qwen-SEA-LION-v4-32B-IT",
		} as { servesUserAnswer?: boolean });

		expect(seen).toHaveLength(4); // two shapes, native then flattened, each bounded at one retry
		for (const init of seen) expect(new Headers(init.headers).has("ChatUI-Fault-Substitute-Model")).toBe(false);
		const shed = errorLog.mock.calls.find(([, msg]) => String(msg).includes("retries were exhausted"));
		expect(shed?.[0]).toMatchObject({ served: "aisingapore/Qwen-SEA-LION-v4-32B-IT", substituted: true });
	});

	it("retries and sheds a substitution on a SIDE-CALL too — served-vs-requested applies regardless of servesUserAnswer", async () => {
		const { seen } = await runTurnSequenceExpectingShed(
			[
				{ backend: CSCS, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
				{ backend: CSCS, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			],
			{} // no servesUserAnswer
		);

		expect(seen).toHaveLength(2); // substitution retried even though this isn't the user's answer
	});

	it("never retries a SIDE-CALL for backend location alone — Olmo/EuroLLM routing is intentional", async () => {
		const { seen } = await runTurnSequence(
			[{ backend: OFF_ALLOWLIST }, { backend: CSCS }],
			{} // no servesUserAnswer — a title/search-decision/second-opinion side-call
		);

		expect(seen).toHaveLength(1); // never reaches the second stubbed response
		expect(warn).not.toHaveBeenCalled();
	});
});

// A gateway can route to a different deployment inside the Apertus group, so every
// header names Apertus (group, model-name, zero fallbacks) while every streamed chunk names SEA-LION.
// Such an answer must not be saved as Apertus.
describe("a substitution the headers can't see: the BODY names another model", () => {
	const FEATHERLESS = "https://api.featherless.ai/v1";
	const SEA_LION = "aisingapore/Qwen-SEA-LION-v4-32B-IT";

	it("retries when every header names the requested model but the body names another, and recovers", async () => {
		const { seen, routerMetadata } = await runTurnSequence(
			[{ backend: FEATHERLESS, bodyModel: SEA_LION }, { backend: FEATHERLESS }],
			{ servesUserAnswer: true }
		);

		expect(seen).toHaveLength(2);
		expect(routerMetadata?.model).toBe("swiss-ai/apertus-v1.5-70b-thinking");
	});

	it("sheds rather than serve it under the requested badge when every attempt's body substitutes", async () => {
		const { seen } = await runTurnSequenceExpectingShed([
			{ backend: FEATHERLESS, bodyModel: SEA_LION },
			{ backend: FEATHERLESS, bodyModel: SEA_LION },
		]);

		expect(seen).toHaveLength(4); // two shapes, native then flattened, each bounded at one retry
		const shed = errorLog.mock.calls.filter(([, msg]) => String(msg).includes("retries were exhausted"));
		expect(shed).toHaveLength(2); // one shed per shape
		expect(shed[0][0]).toMatchObject({
			group: "swiss-ai/apertus-v1.5-70b-thinking",
			served: SEA_LION,
			substituted: true,
		});
	});

	it("does NOT count a provider's own casing or LiteLLM's openai/ prefix as a different model", async () => {
		// Featherless names Apertus `swiss-ai/Apertus-v1.5-70B`; the gateway alias is lower case. Treating
		// that as a substitution would shed every healthy Featherless answer.
		for (const bodyModel of ["swiss-ai/Apertus-v1.5-70B-Thinking", "openai/swiss-ai/apertus-v1.5-70b-thinking"]) {
			const { seen } = await runTurnSequence([{ backend: FEATHERLESS, bodyModel }], { servesUserAnswer: true });
			expect(seen).toHaveLength(1);
		}
		expect(errorLog).not.toHaveBeenCalled();
	});

	it("does NOT retry or shed when the GROUP header differs from the requested id only in case (CUR-1960)", async () => {
		// A call requesting `swiss-ai/Apertus-v1.5-70B` gets group `swiss-ai/apertus-v1.5-70b`
		// back from real Apertus and must not be shed as a substitution.
		const { seen } = await runTurnSequence([{ backend: FEATHERLESS, group: "swiss-ai/Apertus-v1.5-70B-Thinking" }], {
			servesUserAnswer: true,
		});
		expect(seen).toHaveLength(1);
		expect(errorLog).not.toHaveBeenCalled();
	});

	it("streams the recovered answer intact after peeking at it", async () => {
		stubGatewaySequence([{ backend: FEATHERLESS }]);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: GATEWAY,
			apiKey: "sk-test",
			model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		let text = "";
		for await (const chunk of stream) if ("token" in chunk && chunk.token) text += chunk.token.text;
		expect(text).toBe("hi");
	});
});

describe("routerMetadata.model — the served id the badge actually reads (CUR-874)", () => {
	it("carries the litellm group even on a healthy turn (harmless no-op: group == requested)", async () => {
		const { routerMetadata } = await runTurn(CSCS, { servesUserAnswer: true });
		expect(routerMetadata?.model).toBe("swiss-ai/apertus-v1.5-70b-thinking");
	});

	it("never returns a stream at all when litellm substitutes — CUR-1313 sheds instead of labeling and serving", async () => {
		// This is the CUR-1313 case, not a legitimate configured backup lane (that's laneModelId,
		// sent verbatim and never flagged as a substitution against itself). litellm silently swapping
		// the model on the SAME endpoint now retries then sheds; it does not reach routerMetadata.
		await runTurnSequenceExpectingShed([{ backend: GATEWAY, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" }]);
	});
});

describe("an answer the router sent through OpenRouter (CUR-4683)", () => {
	const OPENROUTER = "https://openrouter.ai/api/v1";

	it("records the provider OpenRouter names as the backend, and OpenRouter as who served it", async () => {
		const { routerMetadata } = await runTurnSequence(
			[{ backend: OPENROUTER, bodyProvider: "Mistral" }],
			{ servesUserAnswer: false }
		);
		expect(routerMetadata).toMatchObject({ backend: "https://api.mistral.ai/v1", provider: "openrouter" });
	});

	it("keeps OpenRouter as the backend when the provider it names has no known host, so no compute is claimed", async () => {
		const { routerMetadata } = await runTurnSequence(
			[{ backend: OPENROUTER, bodyProvider: "SomeHost" }],
			{ servesUserAnswer: false }
		);
		expect(routerMetadata).toMatchObject({ backend: OPENROUTER, provider: "openrouter" });
	});
});

// A per-user local (LAN/self-hosted) endpoint has no gateway in front of it — no
// X-Router-Model, no x-litellm-* headers — so it can never earn routerMetadata the way the catalog
// path does above. localModels.ts seeds it directly instead, since it already knows exactly what
// should be shown (the endpoint's own label + the served model tag). (CUR-1194/CUR-1262)
describe("routerModel/routerProvider — seeding routerMetadata with no gateway in front (CUR-1194)", () => {
	it("seeds routerMetadata.model/.provider from routerModel/routerProvider when no header ever arrives", async () => {
		stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
			routerModel: "nx16g:llama3.2:latest",
			routerProvider: "local",
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		let routerMetadata: { model?: string; provider?: string } | undefined;
		for await (const chunk of stream) {
			if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
		}
		expect(routerMetadata?.model).toBe("nx16g:llama3.2:latest");
		expect(routerMetadata?.provider).toBe("local");
	});

	it("routerModel never leaks onto the WIRE request — that's still the bare modelId", async () => {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
			routerModel: "nx16g:llama3.2:latest",
			routerProvider: "local",
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		for await (const _chunk of stream) {
			// drain
		}
		const body = JSON.parse(seen[0]?.body as string);
		expect(body.model).toBe("llama3.2:latest");
	});

	it("without routerModel, behavior is unchanged — modelId alone still seeds routerMetadata.model (no regression for the catalog backup-lane path)", async () => {
		stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "zai-org/GLM-4.6", name: "glm", parameters: {} },
			modelId: "zai-org/GLM-4.6",
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		let routerMetadata: { model?: string; provider?: string } | undefined;
		for await (const chunk of stream) {
			if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
		}
		expect(routerMetadata?.model).toBe("zai-org/GLM-4.6");
		expect(routerMetadata?.provider).toBeUndefined();
	});
});

// A direct host that sends no provenance header (Mistral's La Plateforme, CUR-2283) would leave a turn
// with no persisted served model, and its badge could never show a measured marker. The body's own
// model id is the record.
describe("a direct host's answer records the model its own body names", () => {
	const MISTRAL = "https://api.mistral.ai/v1";

	async function runDirect(bodyModel: string, extra: Record<string, unknown> = {}) {
		const realGet = config.get.bind(config);
		vi.spyOn(config, "get").mockImplementation((key) => (key === "OPENAI_BASE_URL" ? GATEWAY : realGet(key)));
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(sseBody(bodyModel), {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					})
			)
		);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: MISTRAL,
			apiKey: "sk-test",
			model: { id: "mistral-large-2512", name: "mistral-large-2512", parameters: {} },
			routerProvider: "Mistral AI (La Plateforme)",
			...extra,
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		let routerMetadata: { model?: string; provider?: string; backend?: string } | undefined;
		for await (const chunk of stream) {
			if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
		}
		return routerMetadata;
	}

	afterEach(() => vi.restoreAllMocks());

	it("records the body's model and the host it reached, so the turn reads as measured", async () => {
		const meta = await runDirect("mistral-large-2512");
		expect(meta).toMatchObject({
			model: "mistral-large-2512",
			backend: MISTRAL,
			provider: "Mistral AI (La Plateforme)",
		});
	});

	it("records what the body says answered even when it is not what was asked for", async () => {
		const meta = await runDirect("mistral-medium-2604");
		expect(meta?.model).toBe("mistral-medium-2604");
	});

	it("records Large 4 under our id when La Plateforme answers as mistral-large-4-0, the name we sent it (CUR-3027)", async () => {
		const meta = await runDirect("mistral-large-4-0", {
			model: { id: "mistral-large-2610", name: "mistral-large-2610", parameters: {} },
			modelId: "mistral-large-4-0",
			servedAs: "mistral-large-2610",
		});
		expect(meta?.model).toBe("mistral-large-2610");
	});

	it("does not credit Large 4 to a direct answer from a model other than the one we sent (CUR-3027)", async () => {
		const meta = await runDirect("mistral-medium-2604", {
			model: { id: "mistral-large-2610", name: "mistral-large-2610", parameters: {} },
			modelId: "mistral-large-4-0",
			servedAs: "mistral-large-2610",
		});
		expect(meta?.model).toBe("mistral-medium-2604");
	});

	it("leaves a local endpoint's chosen label alone (CUR-1194)", async () => {
		const meta = await runDirect("llama3.2:latest", {
			baseURL: "http://127.0.0.1:11434/v1",
			routerModel: "nx16g:llama3.2:latest",
			routerProvider: "local",
		});
		expect(meta?.model).toBe("nx16g:llama3.2:latest");
		expect(meta?.backend).toBeUndefined();
	});
});

describe("CUR-1291: {{macro}} expansion in a local endpoint's custom defaultHeaders", () => {
	it("expands {{conversationId}}, {{userId}}, and {{modelId}} on the actual wire request", async () => {
		const seen = stubPlainServer();
		const conversationId = new ObjectId();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
			defaultHeaders: { "X-Trace": "conv={{conversationId}} user={{userId}} model={{modelId}}" },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			conversationId,
			locals: { user: { _id: "user-456" } },
		} as unknown as Parameters<typeof endpoint>[0]);
		for await (const _chunk of stream) {
			// drain
		}
		const sent = new Headers(seen[0]?.headers);
		expect(sent.get("X-Trace")).toBe(
			`conv=${conversationId.toString()} user=user-456 model=llama3.2:latest`
		);
	});

	it("expands an unknown {{name}} to empty string rather than leaving the literal token or throwing", async () => {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
			defaultHeaders: { "X-Custom": "before-{{notAThing}}-after" },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		for await (const _chunk of stream) {
			// drain
		}
		expect(new Headers(seen[0]?.headers).get("X-Custom")).toBe("before--after");
	});

	it("a header with no {{}} at all still reaches the wire unchanged (the pre-existing static-header case, e.g. modelsCatalog.ts's X-HF-Bill-To)", async () => {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
			defaultHeaders: { "X-HF-Bill-To": "some-org" },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
		} as Parameters<typeof endpoint>[0]);
		for await (const _chunk of stream) {
			// drain
		}
		expect(new Headers(seen[0]?.headers).get("X-HF-Bill-To")).toBe("some-org");
	});
});

// ── CUR-1208 over the real wire ──────────────────────────────────────────────────────────────────
// Everything above stubs `fetch` in-process — real logic, but a mocked function call, not a network
// round trip. This section runs a REAL local HTTP server on an OS-assigned port and points
// endpointOai's baseURL at it, so the retry loop performs actual TCP connections, real Node fetch
// (undici), and real SSE bytes over the wire — the same client stack the deployed app uses. What this
// still is NOT: the real LiteLLM gateway. It proves the mechanism survives a real wire, not that the
// real gateway behaves the way this mock says it does — that can only be observed live, on real
// traffic (CUR-1208).
describe("CUR-1208 over the real wire — a real local HTTP server, not a mocked fetch", () => {
	let server: Server | undefined;

	afterEach(async () => {
		if (!server) return;
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = undefined;
	});

	/** Starts a real HTTP server that answers each request with the next entry in `sequence` (clamped
	 *  to the last once exhausted), as a real SSE response over the wire. Returns its base URL and a
	 *  live request counter — read AFTER the turn completes, since it updates from the server's own
	 *  request handler, not the test's main flow. */
	function startMockGateway(sequence: Array<{ backend: string; group?: string }>): {
		baseURL: string;
		callCount: () => number;
	} {
		let calls = 0;
		server = createServer((_req, res) => {
			const { backend, group = "swiss-ai/apertus-v1.5-70b-thinking" } =
				sequence[Math.min(calls, sequence.length - 1)];
			calls++;
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"x-litellm-model-api-base": backend,
				"x-litellm-model-group": group,
			});
			res.end(sseBody());
		});
		server.listen(0);
		const { port } = server.address() as AddressInfo;
		return { baseURL: `http://127.0.0.1:${port}/v1`, callCount: () => calls };
	}

	it("retries over a real TCP connection and recovers when the substitution clears", async () => {
		const { baseURL, callCount } = startMockGateway([
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			{ backend: CSCS }, // default group === requested
		]);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL,
			apiKey: "sk-test",
			model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);

		let routerMetadata: { model?: string; backend?: string } | undefined;
		let answerText = "";
		for await (const chunk of stream) {
			if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
			if ("token" in chunk && chunk.token?.text) answerText += chunk.token.text;
		}

		expect(callCount()).toBe(2); // one real retry over the wire, not a failover chain
		expect(routerMetadata?.backend).toBe(CSCS);
		expect(warn).not.toHaveBeenCalled();
		expect(answerText).toContain("hi"); // the real SSE body, decoded over a real connection
	});

	it("bounds the retry at 2 real requests, then sheds rather than serve the substitute", async () => {
		const { baseURL, callCount } = startMockGateway([
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
			{ backend: OFF_ALLOWLIST, group: "aisingapore/Qwen-SEA-LION-v4-32B-IT" },
		]);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL,
			apiKey: "sk-test",
			model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
		});

		await expect(
			endpoint({
				messages: [{ from: "user", content: "hi" }],
				locals: undefined,
				servesUserAnswer: true,
			} as Parameters<typeof endpoint>[0])
		).rejects.toMatchObject({ status: 503 });

		expect(callCount()).toBe(4); // two per shape; the real server could have answered more, the client stopped asking
		expect(errorLog).toHaveBeenCalledTimes(2); // one shed per shape
	});
});

// ── The outgoing messages array (CUR-1294) ────────────────────────────────────────────────────────
// The tests above drive one `user` message and assert on provenance headers. The tests below cover the
// preprompt-merge branch and the flatten that follows it, on the one payload field the gateway routes by.

/** The parsed request body the SDK actually sent on attempt `n`. */
function sentBody(seen: RequestInit[], n = 0): { messages: Array<{ role: string; content: unknown }> } {
	return JSON.parse(String(seen[n]?.body ?? "{}"));
}

async function runTurnWith(params: {
	messages: Array<{ from: string; content: string }>;
	preprompt?: string;
	servesUserAnswer?: boolean;
}) {
	const seen = stubGatewayServing(GATEWAY);
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: GATEWAY,
		apiKey: "sk-test",
		model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
	});
	const stream = await endpoint({ locals: undefined, ...params } as Parameters<typeof endpoint>[0]);
	for await (const _ of stream) void _;
	return sentBody(seen);
}

const HISTORY = [
	{ from: "user", content: "who won in 1990?" },
	{ from: "assistant", content: "Liechtenstein." },
	{ from: "user", content: "and in 2002?" },
];

describe("the outgoing messages array", () => {
	it("sends real roles first while native-first is at its code default (CUR-1886)", async () => {
		// The flattened transcript is what makes a later answer copy an earlier one, so with the kill
		// switch untouched the answer lane must try the role-shaped conversation and stop there when
		// the gateway accepts it.
		const seen = stubGatewayServing(GATEWAY);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: GATEWAY,
			apiKey: "sk-test",
			model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
		});
		const stream = await endpoint({
			locals: undefined,
			messages: HISTORY,
			preprompt: "You are Alpha.",
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		expect(seen).toHaveLength(1);
		expect(sentBody(seen).messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
		]);
	});

	it("resends the same turn flattened when the gateway rejects the role-shaped one (CUR-1886)", async () => {
		// A deployment that rejects assistant roles, with fallbacks disabled, surfaces as an HTTP error
		// before any token. The turn must still be answered, in the shape that deployment accepts.
		const seen: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				seen.push(init ?? {});
				if (seen.length === 1)
					return new Response(JSON.stringify({ error: { message: "role not supported" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					});
				return new Response(sseBody(), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-litellm-model-api-base": GATEWAY,
						"x-litellm-model-group": "swiss-ai/apertus-v1.5-70b-thinking",
					},
				});
			})
		);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: GATEWAY,
			apiKey: "sk-test",
			model: { id: "swiss-ai/apertus-v1.5-70b-thinking", name: "apertus", parameters: {} },
		});
		const stream = await endpoint({
			locals: undefined,
			messages: HISTORY,
			preprompt: "You are Alpha.",
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		expect(seen).toHaveLength(2);
		expect(sentBody(seen, 0).messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
		]);
		expect(sentBody(seen, 1).messages.map((m) => m.role)).toEqual(["user"]);
		expect(String(sentBody(seen, 1).messages[0].content)).toContain("[ASSISTANT] Liechtenstein.");
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "native-first", shape: "flat-retry" }),
			"[native-first] served shape"
		);
	});

	it("leaves a side-lane call alone", async () => {
		// `servesUserAnswer` is the whole scope boundary. The search classifier, entity-scope guard,
		// world model and second-opinion panel all come through this same closure, and a flatten that
		// reached them would change five subsystems' serving model at once.
		const body = await runTurnWith({
			messages: HISTORY,
			preprompt: "You are a classifier.",
			servesUserAnswer: false,
		});
		expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
	});

	// The workaround is for models some lane refuses roles on, read from the verified profiles. (CUR-2145)
	async function answerTurn(modelId: string, seen: RequestInit[]) {
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: GATEWAY,
			apiKey: "sk-test",
			model: { id: modelId, name: modelId, parameters: {} },
		});
		const stream = await endpoint({
			locals: undefined,
			messages: HISTORY,
			preprompt: "You are Alpha.",
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		return seen;
	}

	it("keeps a GLM answer's roles, since every measured GLM lane serves them (CUR-2145)", async () => {
		const seen = await answerTurn("zai-org/GLM-5.3", stubGatewaySequence([{ backend: GATEWAY, group: "zai-org/GLM-5.3", bodyModel: "zai-org/GLM-5.3" }]));
		expect(seen).toHaveLength(1);
		expect(sentBody(seen).messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
	});

	it("never sends a GLM answer a second, flattened request, even when the first one fails (CUR-2145)", async () => {
		const seen: RequestInit[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				seen.push(init ?? {});
				return new Response(JSON.stringify({ error: { message: "upstream error" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				});
			})
		);
		await expect(answerTurn("zai-org/GLM-5.3", seen)).rejects.toBeTruthy();
		expect(seen).toHaveLength(1);
		expect(info).not.toHaveBeenCalledWith(expect.anything(), "[native-first] served shape");
	});

	it("keeps the flattened resend for Apertus 1.5 70B, which Featherless serves only as one user message (CUR-2145)", () => {
		expect(answersNativeFirst("swiss-ai/apertus-v1.5-70b")).toBe(true);
	});

	it("merges the preprompt ahead of a conversation's own system message", async () => {
		const body = await runTurnWith({
			messages: [
				{ from: "system", content: "Answer in French." },
				{ from: "user", content: "hi" },
			],
			preprompt: "You are Alpha.",
			servesUserAnswer: true,
		});
		expect(body.messages[0].role).toBe("system");
		expect(String(body.messages[0].content)).toBe("You are Alpha.\n\nAnswer in French.");
	});
});

// Reached through the backup lane, a GLM title call can spend its whole token budget reasoning and
// come back empty (CUR-1933). A side call to GLM goes out with thinking off; the answer keeps it, since the
// stream strips the reasoning there. On the HF router the side call is also pinned to the provider
// measured to honour the field, since the router's own pick varies per request (CUR-2090).
describe("thinking is off on a GLM side call, and only there (CUR-1933, CUR-2090)", () => {
	async function sentBody(
		modelId: string,
		params: { servesUserAnswer?: boolean; provider?: string }
	) {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "https://router.huggingface.co/v1",
			apiKey: "sk-test",
			model: { id: modelId, name: modelId, parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			...params,
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		return JSON.parse(String(seen[0].body)) as {
			model: string;
			thinking?: { type: string };
			reasoning_effort?: string;
		};
	}

	it("sends thinking disabled to zai-org on an HF-router GLM-5.2-FP8 side call, never reasoning_effort", async () => {
		const body = await sentBody("zai-org/GLM-5.2-FP8", {});
		expect(body.model).toBe("zai-org/GLM-5.2-FP8:zai-org");
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning_effort).toBeUndefined();
	});

	it("sends a GLM-5.2 side call to scaleway with reasoning_effort none and no thinking field", async () => {
		const body = await sentBody("zai-org/GLM-5.2", {});
		expect(body.model).toBe("zai-org/GLM-5.2:scaleway");
		expect(body.reasoning_effort).toBe("none");
		expect(body.thinking).toBeUndefined();
	});

	// unpinned, the router would choose who receives the text, Z.ai's own endpoint included. (CUR-2112)
	it("refuses a GLM call with no pin before anything is sent, naming the id", async () => {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "https://router.huggingface.co/v1",
			apiKey: "sk-test",
			model: { id: "zai-org/GLM-5.3", name: "zai-org/GLM-5.3", parameters: {} },
		});
		await expect(
			endpoint({
				messages: [{ from: "user", content: "hi" }],
				locals: undefined,
				servesUserAnswer: true,
				provider: "auto",
			} as Parameters<typeof endpoint>[0])
		).rejects.toThrow(/zai-org\/GLM-5\.3 has no HF provider pin/);
		expect(seen).toHaveLength(0);
	});

	it("leaves thinking on for the GLM answer, and still pins its provider", async () => {
		const body = await sentBody("zai-org/GLM-5.2", { servesUserAnswer: true });
		expect(body.thinking).toBeUndefined();
		expect(body.model).toBe("zai-org/GLM-5.2:scaleway");
	});

	it("pins a GLM call that asked for provider auto, so the router never picks who gets the text", async () => {
		const body = await sentBody("zai-org/GLM-5.2", { servesUserAnswer: true, provider: "auto" });
		expect(body.model).toBe("zai-org/GLM-5.2:scaleway");
	});

	// With reasoning off, a GLM 5.2 answer carries its reasoning in the answer text ("Let me answer from
	// the document.", CUR-4189). With it on, Scaleway streams the reasoning apart, into the Working panel.
	it("keeps reasoning on for a GLM answer on the HF router, still pinned, while its side call turns it off", async () => {
		const send = async (servesUserAnswer: boolean) => {
			const seen = stubPlainServer();
			const endpoint = await endpointOai({
				type: "openai",
				baseURL: "https://router.huggingface.co/v1",
				apiKey: "sk-test",
				model: { id: "zai-org/GLM-5.2", name: "zai-org/GLM-5.2", parameters: {} },
			});
			const stream = await endpoint({
				messages: [{ from: "user", content: "hi" }],
				locals: undefined,
				servesUserAnswer,
			} as Parameters<typeof endpoint>[0]);
			for await (const _ of stream) void _;
			return JSON.parse(String(seen[0].body)) as { model: string; reasoning_effort?: string };
		};
		const answer = await send(true);
		expect(answer.model).toBe("zai-org/GLM-5.2:scaleway");
		expect(answer.reasoning_effort).toBeUndefined();
		const side = await send(false);
		expect(side.model).toBe("zai-org/GLM-5.2:scaleway");
		expect(side.reasoning_effort).toBe("none");
	});

	it("lets an explicit per-request provider win over the pin", async () => {
		const body = await sentBody("zai-org/GLM-5.3", { servesUserAnswer: true, provider: "baseten" });
		expect(body.model).toBe("zai-org/GLM-5.3:baseten");
	});

	it("leaves thinking alone on an Apertus side call", async () => {
		expect((await sentBody("swiss-ai/apertus-v1.5-70b-thinking", {})).thinking).toBeUndefined();
	});
});

// The second-opinion route asks every panelist for `reasoning_effort: "none"` so the budget goes to
// the answer. gpt-oss-120b has no off switch and answers that with a 400, so the effort sent is the
// lowest one its verified profile row accepts (CUR-2113). The panel sends provider "auto".
describe("a panelist's reasoning_effort follows its verified profile (CUR-2113)", () => {
	async function panelistBody(modelId: string) {
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: "https://router.huggingface.co/v1",
			apiKey: "sk-test",
			model: { id: modelId, name: modelId, parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			reasoningEffort: "none",
			provider: "auto",
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		return JSON.parse(String(seen[0].body)) as { model: string; reasoning_effort?: string };
	}

	it("sends gpt-oss-120b an effort its profile accepts instead of the none it rejects", async () => {
		expect((await panelistBody("openai/gpt-oss-120b")).reasoning_effort).toBe("low");
	});

	it("keeps none for a panelist whose profile accepts it", async () => {
		expect((await panelistBody("google/gemma-4-26b-a4b-it")).reasoning_effort).toBe("none");
	});

	it("passes none through for a model no probe has measured", async () => {
		expect((await panelistBody("allenai/Olmo-3-32B-Think")).reasoning_effort).toBe("none");
	});
});

describe("an answer from the staging router is recorded under our id only when its version checks out (CUR-2928)", () => {
	const ROUTER = "https://router.example.test/v1";

	async function routerTurn(upstream = "openai/mistral-large-latest", ours = "mistral-large-2512") {
		const seen: { body?: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				seen.push({ body: typeof init?.body === "string" ? init.body : undefined });
				return new Response(sseBody(`mistralai/${ours}`), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-litellm-model-api-base": "https://api.mistral.ai/v1",
						"x-litellm-model-group": `mistralai/${ours}`,
						"x-litellm-model-name": upstream,
					},
				});
			})
		);
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: ROUTER,
			apiKey: "sk-test",
			modelId: `mistralai/${ours}`,
			servedAs: ours,
			model: { id: ours, name: ours, parameters: {} },
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			servesUserAnswer: true,
		} as Parameters<typeof endpoint>[0]);
		let routerMetadata: { model?: string; backend?: string } | undefined;
		for await (const chunk of stream) {
			if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
		}
		return { seen, routerMetadata };
	}

	it("asks the router for its own id and records ours when Mistral lists the router's upstream as that version", async () => {
		isSameMistralModel.mockResolvedValueOnce(true);
		const { seen, routerMetadata } = await routerTurn();
		expect(JSON.parse(seen[0].body ?? "{}").model).toBe("mistralai/mistral-large-2512");
		expect(isSameMistralModel).toHaveBeenLastCalledWith("openai/mistral-large-latest", "mistral-large-2512");
		expect(routerMetadata?.model).toBe("mistral-large-2512");
		expect(routerMetadata?.backend).toBe("https://api.mistral.ai/v1");
	});

	// The router reports Mistral's own host as its backend, the same host a direct turn reports,
	// so only the host we sent to says the router carried this turn. (CUR-3193)
	it("records the router as the turn's lane even though its backend names api.mistral.ai", async () => {
		isSameMistralModel.mockResolvedValueOnce(true);
		const { routerMetadata } = await routerTurn();
		expect(routerMetadata).toMatchObject({ backend: "https://api.mistral.ai/v1", lane: "router.example.test" });
	});

	it("records ours without reading Mistral's model list when the router asked for our dated version", async () => {
		isSameMistralModel.mockClear();
		const { routerMetadata } = await routerTurn("openai/mistral-large-2512");
		expect(isSameMistralModel).not.toHaveBeenCalled();
		expect(routerMetadata?.model).toBe("mistral-large-2512");
	});

	it("claims no version when Mistral's latest has moved past our pin: records what the router asked for", async () => {
		isSameMistralModel.mockResolvedValueOnce(false);
		const { routerMetadata } = await routerTurn();
		expect(routerMetadata?.model).toBe("mistral-large-latest");
	});

	it("claims no version when Mistral's model list could not be read", async () => {
		isSameMistralModel.mockResolvedValueOnce(undefined);
		const { routerMetadata } = await routerTurn();
		expect(routerMetadata?.model).toBe("mistral-large-latest");
	});

	it("records Large 4 (preview) under our id when the router asked Mistral for mistral-large-4, which Mistral's list cannot date (CUR-3027)", async () => {
		isSameMistralModel.mockClear();
		const { routerMetadata } = await routerTurn("openai/mistral-large-4", "mistral-large-2610");
		expect(isSameMistralModel).not.toHaveBeenCalled();
		expect(routerMetadata?.model).toBe("mistral-large-2610");
	});

	it("does not credit Large 4 to an answer the router got from a different Mistral model (CUR-3027)", async () => {
		isSameMistralModel.mockResolvedValueOnce(false);
		const { routerMetadata } = await routerTurn("openai/mistral-large-latest", "mistral-large-2610");
		expect(routerMetadata?.model).toBe("mistral-large-latest");
	});

	it("does not treat the router's prefixed id as a substitution, so the answer is served on the first attempt", async () => {
		const { seen } = await routerTurn();
		expect(seen).toHaveLength(1);
	});
});

// The history is fitted to the lane's context (CUR-2893); sending it whole fails every Retry of a chat
// past that context. A model with no harness row gets the 32000-token floor.
describe("the history is fitted to the lane's context before the call (CUR-2893)", () => {
	const localEndpoint = () =>
		endpointOai({
			type: "openai",
			baseURL: "http://127.0.0.1:11434/v1",
			apiKey: "sk-",
			model: { id: "local:abc123", name: "llama3.2:latest", parameters: {} },
			modelId: "llama3.2:latest",
		});
	const longChat = (pairs: number) => {
		const out: Array<{ from: "user" | "assistant"; content: string }> = [];
		for (let i = 0; i < pairs; i++) {
			out.push({ from: "user", content: `question ${i} ` + "q".repeat(3_000) });
			out.push({ from: "assistant", content: `answer ${i} ` + "a".repeat(3_000) });
		}
		out.push({ from: "user", content: "the newest question" });
		return out;
	};

	it("sends a chat over the context with its oldest exchanges left out and its newest message intact", async () => {
		const seen = stubPlainServer();
		const endpoint = await localEndpoint();
		// 40 exchanges of ~2,000 estimated tokens each, against a 32000 floor less a 4096 reserve.
		const reported: number[] = [];
		const stream = await endpoint({
			messages: longChat(40),
			locals: undefined,
			onHistoryFitted: (n: number) => reported.push(n),
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		const sent = JSON.parse(String(seen[0].body)).messages as Array<{ role: string; content: string }>;
		// Reported to the caller so the answer can say so: the exchanges missing from what was sent.
		expect(reported).toEqual([(81 - sent.length) / 2]);
		expect(sent.length).toBeLessThan(81);
		expect(sent.at(-1)?.content).toBe("the newest question");
		expect(sent.some((m) => m.content.startsWith("question 0 "))).toBe(false);
		expect(sent.some((m) => m.content.startsWith("question 39 "))).toBe(true);
		expect(info).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "fit-history", leftOut: expect.any(Number) }),
			expect.any(String)
		);
	});

	it("sends a chat under the context whole", async () => {
		const seen = stubPlainServer();
		const endpoint = await localEndpoint();
		const reported: number[] = [];
		const stream = await endpoint({
			messages: longChat(3),
			locals: undefined,
			onHistoryFitted: (n: number) => reported.push(n),
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		expect(JSON.parse(String(seen[0].body)).messages).toHaveLength(7);
		expect(reported).toEqual([0]);
	});

	it("refuses a newest message over the context before any request leaves", async () => {
		const seen = stubPlainServer();
		const endpoint = await localEndpoint();
		await expect(
			endpoint({
				messages: [{ from: "user", content: "z".repeat(200_000) }],
				locals: undefined,
			} as Parameters<typeof endpoint>[0])
		).rejects.toBeInstanceOf(MessageTooLongError);
		expect(seen).toHaveLength(0);
	});
});

// A compare model reaches its host on its own key (CUR-1875). With OPENAI_PROVIDER set, sending
// `<id>:publicai` there would hit an HF-router suffix a direct host answers with nothing until the
// timeout. Side calls and turns take the same rule from wireModelId.
describe("an own-lane model never takes the default provider pin (CUR-1875)", () => {
	const OWN_HOST = "https://compare.example.org/v1";

	async function sentModel(endpointExtra: Record<string, unknown>, provider?: string) {
		const realGet = config.get.bind(config);
		// `ConfigKey` is generated from whichever env built the types, so compare as a plain string.
		const fake: Record<string, string> = { OPENAI_PROVIDER: "publicai", SECOND_OPINION_API_KEY: "compare-key" };
		vi.spyOn(config, "get").mockImplementation((key) => fake[key as string] ?? realGet(key));
		const seen = stubPlainServer();
		const endpoint = await endpointOai({
			type: "openai",
			baseURL: OWN_HOST,
			apiKey: "sk-test",
			model: { id: "allenai/Olmo-3-32B", name: "allenai/Olmo-3-32B", parameters: {} },
			...endpointExtra,
		});
		const stream = await endpoint({
			messages: [{ from: "user", content: "hi" }],
			locals: undefined,
			servesUserAnswer: true,
			provider,
		} as Parameters<typeof endpoint>[0]);
		for await (const _ of stream) void _;
		return (JSON.parse(String(seen[0].body)) as { model: string }).model;
	}

	afterEach(() => vi.restoreAllMocks());

	it("sends the bare id to a lane on its own key, with OPENAI_PROVIDER=publicai and no per-request provider", async () => {
		expect(await sentModel({ apiKeyEnv: "SECOND_OPINION_API_KEY" })).toBe("allenai/Olmo-3-32B");
	});

	it("still pins a lane on the global key, so the default keeps steering gateway traffic", async () => {
		expect(await sentModel({})).toBe("allenai/Olmo-3-32B:publicai");
	});

	it("lets an explicit per-request provider through on an own lane", async () => {
		expect(await sentModel({ apiKeyEnv: "SECOND_OPINION_API_KEY" }, "nscale")).toBe("allenai/Olmo-3-32B:nscale");
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const warn = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() },
}));

vi.mock("$lib/chat/server/flags", () => ({
	flagEnabledOr: (_key: string, fallback: () => boolean) => fallback(),
	ensureFlagsPolled: async () => {},
	flagsDebugState: () => ({ polledOk: true, lastRefreshAt: 0, size: 1 }),
}));

const { endpointOai } = await import("./endpointOai");
const { resetStrictLaneCacheForTests, roleCapableDeployment } = await import("./apertusStrictLane");

const GATEWAY = "https://api-internal.publicai.co/v1";
const GROUP = "swiss-ai/apertus-v1.5-70b";
const INFOMANIAK_ID = "inf0000000000000000000000000000000000000000000000000000000000001";
const FEATHERLESS_ID = "fea0000000000000000000000000000000000000000000000000000000000002";

// The shape `GET /v1/model/info` returns, trimmed to the fields the resolver reads.
const MODEL_INFO = {
	data: [
		{
			model_name: GROUP,
			litellm_params: { api_base: "https://api.infomaniak.com/2/ai/106744/openai/v1" },
			model_info: { id: INFOMANIAK_ID },
		},
		{
			model_name: GROUP,
			litellm_params: { api_base: "https://api.featherless.ai/v1" },
			model_info: { id: FEATHERLESS_ID },
		},
	],
};

function sse(model: string): string {
	const chunk = (delta: object, finish: string | null) =>
		`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	return chunk({ role: "assistant", content: "hi" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
}

type Call = { url: string; body?: Record<string, unknown> };

/**
 * A gateway that behaves as follows: a pinned request is answered under
 * the deployment id in the group header and in every chunk; a group request is answered under the group.
 */
function stubGateway(opts: { modelInfoStatus?: number } = {}) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/model/info")) {
				calls.push({ url });
				const status = opts.modelInfoStatus ?? 200;
				return new Response(status === 200 ? JSON.stringify(MODEL_INFO) : "no", { status });
			}
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			calls.push({ url, body });
			const served = String(body.model);
			return new Response(sse(served), {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-litellm-model-group": served,
					"x-litellm-model-api-base":
						served === GROUP || served === INFOMANIAK_ID
							? "https://api.infomaniak.com/2/ai/106744/openai/v1"
							: "https://api.featherless.ai/v1",
				},
			});
		})
	);
	return calls;
}

async function call(opts: { preprompt?: string; answer?: boolean } = {}) {
	const endpoint = await endpointOai({
		type: "openai",
		baseURL: GATEWAY,
		apiKey: "sk-test",
		model: { id: GROUP, name: "apertus", parameters: {} },
	});
	const stream = await endpoint({
		messages: [{ from: "user", content: "name this chat" }],
		preprompt: opts.preprompt,
		locals: undefined,
		servesUserAnswer: opts.answer ?? false,
	} as Parameters<typeof endpoint>[0]);
	let routerMetadata: { model?: string } | undefined;
	for await (const chunk of stream) {
		if ("routerMetadata" in chunk && chunk.routerMetadata) routerMetadata = chunk.routerMetadata;
	}
	return { routerMetadata };
}

const completions = (calls: Call[]) => calls.filter((c) => c.body);

beforeEach(() => {
	warn.mockClear();
	resetStrictLaneCacheForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("every Apertus call (CUR-2092, flag retired in CUR-2853)", () => {
	it("pins the answer lane's role-shaped call to the role-capable deployment and refuses substitution", async () => {
		const calls = stubGateway();
		await call({ preprompt: "You are Alpha.", answer: true });
		const reqs = completions(calls);
		expect(reqs).toHaveLength(1);
		expect(reqs[0].body?.model).toBe(INFOMANIAK_ID);
		expect(reqs[0].body?.disable_fallbacks).toBe(true);
	});

	it("records the GROUP as the served model, not the deployment id, and does not retry it as a substitution", async () => {
		const calls = stubGateway();
		const { routerMetadata } = await call({ preprompt: "You are Alpha.", answer: true });
		expect(routerMetadata?.model).toBe(GROUP);
		expect(completions(calls)).toHaveLength(1);
	});

	it("leaves a user-only call on the group, since both deployments serve that shape", async () => {
		const calls = stubGateway();
		await call({ answer: true });
		const [req] = completions(calls);
		expect(req.body?.model).toBe(GROUP);
		expect(req.body?.disable_fallbacks).toBe(true);
	});

	it("falls back to the unpinned group, loudly, when model/info can't be read", async () => {
		const calls = stubGateway({ modelInfoStatus: 403 });
		await call({ preprompt: "You are Alpha.", answer: true });
		const [req] = completions(calls);
		expect(req.body?.model).toBe(GROUP);
		expect(req.body?.disable_fallbacks).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "strict-lane" }),
			expect.stringContaining("model/info")
		);
	});

	it("leaves a role-shaped SIDE call on the group, still refusing substitution: side calls are not pinned", async () => {
		const calls = stubGateway();
		await call({ preprompt: "You name chats." });
		expect(calls.some((c) => c.url.endsWith("/model/info"))).toBe(false);
		const [req] = completions(calls);
		expect(req.body?.model).toBe(GROUP);
		expect(req.body?.disable_fallbacks).toBe(true);
	});

	it("reads model/info once and serves later pins from the cache", async () => {
		const calls = stubGateway();
		await call({ preprompt: "a", answer: true });
		await call({ preprompt: "b", answer: true });
		expect(calls.filter((c) => c.url.endsWith("/model/info"))).toHaveLength(1);
	});
});

describe("roleCapableDeployment", () => {
	it("never pins a group the table doesn't list, even when the gateway has a matching host", async () => {
		stubGateway();
		expect(await roleCapableDeployment("swiss-ai/apertus-70b-instruct", GATEWAY, "sk")).toBeUndefined();
	});

	it("returns nothing when the listed host is missing from the group, instead of guessing another", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ data: [MODEL_INFO.data[1]] }), { status: 200 }))
		);
		expect(await roleCapableDeployment(GROUP, GATEWAY, "sk")).toBeUndefined();
	});
});

describe("Apertus strict lane, body substitution on the pinned deployment (CUR-2144)", () => {
	// servedGroupFor maps back only the deployment id this lane pinned. A body naming any other model has
	// to stay unmapped, or the substitution check goes blind on exactly the lane that exists to refuse it.
	it("a pinned strict-lane answer whose body names another model is refused as substitution", async () => {
		const calls: Call[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url.endsWith("/model/info")) return new Response(JSON.stringify(MODEL_INFO), { status: 200 });
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				calls.push({ url, body });
				// The header names the pinned deployment, as a healthy pinned answer does; every chunk names
				// the model that actually answered.
				return new Response(sse("aisingapore/Qwen-SEA-LION-v4-32B-IT"), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-litellm-model-group": String(body.model),
						"x-litellm-model-api-base": "https://api.infomaniak.com/2/ai/106744/openai/v1",
					},
				});
			})
		);
		await expect(call({ preprompt: "You are Alpha.", answer: true })).rejects.toThrow(
			/model substitution exhausted retries/
		);
		// Every role-shaped attempt is pinned. Native-first's flattened resend carries only a user
		// message, which every deployment serves, so it goes to the group unpinned.
		const roleShaped = completions(calls).filter((r) =>
			(r.body?.messages as { role: string }[] | undefined)?.some((m) => m.role !== "user")
		);
		expect(roleShaped.length).toBeGreaterThan(1);
		expect(roleShaped.every((r) => r.body?.model === INFOMANIAK_ID)).toBe(true);
	});
});

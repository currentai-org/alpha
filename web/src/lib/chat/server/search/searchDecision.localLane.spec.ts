import { beforeEach, describe, expect, it, vi } from "vitest";

// A turn served by a visitor-registered local endpoint must not send the search classifier,
// which carries the deployment's gateway key, to the URL the visitor typed. Hermetic: models, config
// and the client factory are stubbed, and the test reads what the decider hands the client.
const h = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	clientOpts: [] as Array<{ baseURL?: string; apiKey?: string }>,
	bodies: [] as Array<{ model?: string }>,
}));

vi.mock("$lib/chat/server/models", () => ({
	models: [],
	defaultModel: { id: "default-model", name: "default-model" },
	taskModel: { id: "default-model", name: "default-model" },
}));
vi.mock("$lib/chat/server/config", () => ({ config: h.cfg }));
vi.mock("$lib/chat/server/openaiClient", () => ({
	createOpenAIClient: async (opts: { baseURL?: string; apiKey?: string }) => {
		h.clientOpts.push(opts);
		return {
			chat: {
				completions: {
					create: async (body: { model?: string }) => {
						h.bodies.push(body);
						return { choices: [{ message: { tool_calls: [] } }] };
					},
				},
			},
		};
	},
}));

import { decideSearchViaTool } from "./searchDecision";

const GATEWAY = "https://api-internal.publicai.co/v1";
const VISITOR_URL = "https://attacker.example/v1";
const GATEWAY_KEY = "sentinel-gateway-key";

/** The shape buildLocalProcessedModel gives a visitor's endpoint (localModels.ts). */
const localServingModel = {
	id: "local:endpoint-1:llama",
	name: "my-box:llama",
	endpoints: [
		{
			type: "openai",
			baseURL: VISITOR_URL,
			apiKey: "sk-local",
			modelId: "llama",
			routerProvider: "local",
		},
	],
};

describe("decideSearchViaTool on a local-endpoint turn", () => {
	beforeEach(() => {
		h.clientOpts.length = 0;
		h.bodies.length = 0;
		for (const k of Object.keys(h.cfg)) delete h.cfg[k];
		h.cfg.OPENAI_BASE_URL = GATEWAY;
		h.cfg.OPENAI_API_KEY = GATEWAY_KEY;
	});

	it("never sends the gateway key to the visitor's URL: the classifier goes to our gateway on the default model", async () => {
		const verdict = await decideSearchViaTool("what happened today", undefined, localServingModel as never);
		expect(verdict.ok).toBe(true);
		expect(h.clientOpts).toHaveLength(1);
		expect(h.clientOpts[0]?.baseURL).toBe(GATEWAY);
		expect(h.clientOpts[0]?.baseURL).not.toBe(VISITOR_URL);
		expect(h.bodies[0]?.model).not.toBe("llama");
	});

	it("still sends a catalog turn's classifier to that model's own lane (the fix doesn't reroute every turn)", async () => {
		h.cfg.OWN_KEY = "own";
		const ownLane = {
			id: "own-model",
			name: "own-model",
			endpoints: [{ type: "openai", baseURL: "https://own.example/v1", apiKeyEnv: "OWN_KEY" }],
		};
		await decideSearchViaTool("what happened today", undefined, ownLane as never);
		expect(h.clientOpts[0]?.baseURL).toBe("https://own.example/v1");
		expect(h.clientOpts[0]?.apiKey).toBe("own");
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// The forced side call on TASK_MODEL's lane (violenceRecheck, groundcheck). The request must name the
// model the way its host does: the endpoint's `modelId`, which side-call registration sets to the
// router's wire id. Sending the TASK_MODEL id as written draws a 400 from a router that names the model
// differently, and the violence re-check then fails closed (CUR-3057).
const sent: Record<string, unknown>[] = [];
let endpoint: { baseURL: string; apiKeyEnv: string; modelId?: string };

vi.mock("$lib/chat/server/config", () => ({
	config: { TASK_MODEL: "mistral-small-2603", TASK_LANE_KEY: "k" },
}));
vi.mock("$lib/chat/server/models", () => ({
	get models() {
		return [{ id: "mistral-small-2603", endpoints: [endpoint] }];
	},
}));
vi.mock("$lib/chat/server/openaiClient", () => ({
	createOpenAIClient: async () => ({
		chat: {
			completions: {
				create: async (body: Record<string, unknown>) => {
					sent.push(body);
					return { choices: [{ message: { tool_calls: [{ function: { name: "t", arguments: "{}" } }] } }] };
				},
			},
		},
	}),
}));

const { forcedTaskModelToolCall } = await import("./taskModelClient");

const call = () =>
	forcedTaskModelToolCall({
		system: "s",
		user: "u",
		tool: { type: "function", function: { name: "t", parameters: { type: "object" } } },
		maxTokens: 8,
		timeoutMs: 1_000,
		signal: new AbortController().signal,
	});

describe("forcedTaskModelToolCall", () => {
	beforeEach(() => {
		sent.length = 0;
	});

	it("sends the endpoint's wire id, not the TASK_MODEL id, when the host names the model differently", async () => {
		endpoint = { baseURL: "https://router.example/v1", apiKeyEnv: "TASK_LANE_KEY", modelId: "mistralai/mistral-small-2603" };
		await call();
		expect(sent[0]?.model).toBe("mistralai/mistral-small-2603");
	});

	it("sends the TASK_MODEL id when the endpoint carries no wire id of its own", async () => {
		endpoint = { baseURL: "https://api.mistral.ai/v1", apiKeyEnv: "TASK_LANE_KEY" };
		await call();
		expect(sent[0]?.model).toBe("mistral-small-2603");
	});
});

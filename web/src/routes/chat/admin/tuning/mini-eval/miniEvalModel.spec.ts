import { describe, it, expect, vi } from "vitest";

const PICKER_ID = "mistral-medium-2604";
const WIRE_ID = "mistral-medium-3.5-128b";

// The gateway only knows the wire id; the picker id is a 400.
const gatewayCreate = vi.fn(async ({ model }: { model: string }) => {
	if (model !== WIRE_ID) {
		throw new Error(`400 /chat/completions: Invalid model name passed in model=${model}`);
	}
	return { choices: [{ message: { content: "answer from the gateway" } }] };
});
// The model's own endpoint is what a chat turn calls; its lane sends the wire id.
const laneAnswer = vi.fn(async function* () {
	yield { token: { text: "B" }, generated_text: "B" };
});

vi.mock("$lib/chat/server/adminAuth", () => ({ requireAdminPermission: vi.fn(async () => {}) }));
vi.mock("$lib/chat/server/config", () => ({ config: { OPENAI_BASE_URL: "http://gateway.test", OPENAI_API_KEY: "k" } }));
vi.mock("$lib/chat/server/openaiClient", () => ({
	createOpenAIClient: async () => ({ chat: { completions: { create: gatewayCreate } } }),
}));
vi.mock("$lib/chat/server/models", () => ({
	defaultModel: { id: PICKER_ID, name: PICKER_ID, getEndpoint: async () => laneAnswer },
}));
vi.mock("$lib/chat/server/textGeneration/persona", () => ({
	buildPersonaPrompt: (_model: string, persona?: string) => persona ?? "default persona",
	resolveDecoding: () => ({ temperature: 0.1, frequency_penalty: 0, presence_penalty: 0, max_tokens: 512 }),
}));

describe("POST /chat/admin/tuning/mini-eval with the Medium picker id", () => {
	it("grades every slice item on answers from the model's own endpoint, not a 400 for the picker id sent to the gateway", async () => {
		const { POST } = await import("./+server");
		const res = await POST({
			locals: {} as App.Locals,
			cookies: {} as never,
			request: new Request("http://localhost/chat/admin/tuning/mini-eval", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: { id: string; detail: string }[] };
		expect(body.items.length).toBeGreaterThan(0);
		const errored = body.items.filter((i) => i.detail.startsWith("error"));
		expect(errored, "no slice item fails on a model-call error").toEqual([]);
		expect(laneAnswer).toHaveBeenCalled();
		expect(gatewayCreate).not.toHaveBeenCalledWith(expect.objectContaining({ model: PICKER_ID }));
	});
});

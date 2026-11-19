import { describe, it, expect, vi } from "vitest";

const PICKER_ID = "mistral-medium-2604";
const WIRE_ID = "mistral-medium-3.5-128b";

// The gateway only knows the wire id; the picker id is a 400, as on alpha.
const gatewayCreate = vi.fn(async ({ model }: { model: string }) => {
	if (model !== WIRE_ID) {
		throw new Error(`400 /chat/completions: Invalid model name passed in model=${model}`);
	}
	return { choices: [{ message: { content: "answer from the gateway" } }] };
});
// The model's own endpoint is what a chat turn calls; its lane sends the wire id.
const laneAnswer = vi.fn(async function* () {
	yield { token: { text: "answer from the model's lane" }, generated_text: "answer from the model's lane" };
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

describe("POST /chat/admin/tuning/try with the Medium picker id", () => {
	it("returns the model's answer through its own endpoint, not a 400 for the picker id sent to the gateway", async () => {
		const { POST } = await import("./+server");
		const res = await POST({
			locals: {} as App.Locals,
			cookies: {} as never,
			request: new Request("http://localhost/chat/admin/tuning/try", {
				method: "POST",
				body: JSON.stringify({ query: "Say hi in one sentence." }),
			}),
		} as unknown as Parameters<typeof POST>[0]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.answer).toBe("answer from the model's lane");
		expect(gatewayCreate).not.toHaveBeenCalledWith(expect.objectContaining({ model: PICKER_ID }));
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { buildChatRequest, createChatCompletion, postChatCompletion } from "./chatRequest";

const HF = "https://router.huggingface.co/v1";
const GATEWAY = "https://gateway.example/v1";
const MISTRAL = "https://api.mistral.ai/v1";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;
const systemAndUser: Msg[] = [
	{ role: "system", content: "Decide." },
	{ role: "user", content: "Is it raining?" },
];

afterEach(() => vi.unstubAllGlobals());

describe("roles follow the model's profile rows", () => {
	it("an Apertus wire id gets its roles flattened, since one measured lane refuses the system role", () => {
		const out = buildChatRequest(
			{ model: "swiss-ai/apertus-v1.5-70b", messages: systemAndUser, max_tokens: 3 },
			{ baseURL: GATEWAY }
		);
		expect(out.messages).toEqual([{ role: "user", content: "Decide.\n\n[USER] Is it raining?" }]);
	});

	it("a model every measured lane serves with roles keeps its system message", () => {
		const out = buildChatRequest(
			{ model: "zai-org/glm-5.2:scaleway", messages: systemAndUser },
			{ baseURL: HF }
		);
		expect(out.messages).toBe(systemAndUser);
	});

	it("roles: keep sends an Apertus transcript as written, tool results included", () => {
		const transcript: Msg[] = [
			...systemAndUser,
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "42" },
		];
		const out = buildChatRequest(
			{ model: "swiss-ai/apertus-v1.5-70b", messages: transcript },
			{ baseURL: GATEWAY, roles: "keep" }
		);
		expect(out.messages).toBe(transcript);
	});
});

describe("reasoning intent becomes the field the serving pair accepts", () => {
	it("gpt-oss gets an accepted effort, never none, which it answers with a 400", () => {
		const out = buildChatRequest(
			{ model: "openai/gpt-oss-120b:scaleway", messages: systemAndUser },
			{ baseURL: HF, reasoning: "none" }
		);
		expect(out).toMatchObject({ reasoning_effort: "low" });
	});

	it("a model with a reasoning-off row gets that row's fields", () => {
		const novita = buildChatRequest(
			{ model: "zai-org/glm-5.3:novita", messages: systemAndUser },
			{ baseURL: HF, reasoning: "off" }
		);
		expect(novita).toMatchObject({ thinking: { type: "disabled" } });
		expect(novita).not.toHaveProperty("reasoning_effort");

		const scaleway = buildChatRequest(
			{ model: "zai-org/glm-5.2:scaleway", messages: systemAndUser },
			{ baseURL: HF, reasoning: "off" }
		);
		expect(scaleway).toMatchObject({ reasoning_effort: "none" });
		expect(scaleway).not.toHaveProperty("thinking");
	});

	it("a host that is neither the gateway nor the HF router gets no reasoning-off field (Mistral 422s on thinking)", () => {
		const body = { model: "mistral-small-2603", messages: systemAndUser };
		const out = buildChatRequest(body, { baseURL: MISTRAL, reasoning: "off", gatewayBaseURL: GATEWAY });
		expect(JSON.stringify(out)).toBe(JSON.stringify(body));
	});

	it("no reasoning intent sends no reasoning field, even for a model with a reasoning-off row", () => {
		const out = buildChatRequest({ model: "zai-org/glm-5.3:novita", messages: systemAndUser }, { baseURL: HF });
		expect(out).not.toHaveProperty("thinking");
		expect(out).not.toHaveProperty("reasoning_effort");
	});
});

describe("a body no quirk applies to goes out byte-identical", () => {
	it("keeps every field in its own position, so the serialized body is unchanged", () => {
		const body = {
			model: "swiss-ai/apertus-v1.5-70b",
			messages: [{ role: "user" as const, content: "hi" }],
			max_tokens: 1,
			stream: false as const,
			response_format: { type: "json_object" as const },
		};
		expect(JSON.stringify(buildChatRequest(body, { baseURL: GATEWAY }))).toBe(JSON.stringify(body));
	});

	it("appends reasoning fields after the caller's own, where the callers put them before", () => {
		const out = buildChatRequest(
			{ model: "zai-org/glm-5.2:scaleway", messages: systemAndUser, temperature: 0, max_tokens: 9 },
			{ baseURL: HF, reasoning: "off" }
		);
		expect(Object.keys(out)).toEqual(["model", "messages", "temperature", "max_tokens", "reasoning_effort"]);
	});
});

describe("the send helpers send the built body", () => {
	it("createChatCompletion hands the SDK the built body and the caller's request options", async () => {
		const create = vi.fn().mockResolvedValue({ choices: [] });
		const client = { chat: { completions: { create } } } as unknown as OpenAI;
		await createChatCompletion(
			client,
			{ model: "swiss-ai/apertus-v1.5-70b", messages: systemAndUser },
			{ baseURL: GATEWAY },
			{ timeout: 8_000 }
		);
		expect(create).toHaveBeenCalledWith(
			{ model: "swiss-ai/apertus-v1.5-70b", messages: [{ role: "user", content: "Decide.\n\n[USER] Is it raining?" }] },
			{ timeout: 8_000 }
		);
	});

	it("postChatCompletion posts the built body to the base URL's chat-completions route", async () => {
		const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		const body = { model: "m", messages: [{ role: "user" as const, content: "hi" }], max_tokens: 1, stream: false as const };
		await postChatCompletion(GATEWAY, body, {}, { headers: { authorization: "Bearer k" } });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe(`${GATEWAY}/chat/completions`);
		expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer k" } });
		expect(init.body).toBe(JSON.stringify(body));
	});
});

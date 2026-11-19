import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

// The prompt view of a sealed chat: the server cannot open the chat, so a GET is refused
// rather than answered with a prompt built from empty skeletons, and a POST rebuilds it from the bodies
// the owner's browser opened, each checked against its stored MAC. The MAC is the real one under an
// invented key; the store and the model are stand-ins.

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	doc: null as Record<string, unknown> | null,
}));
vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		conversations: {
			findOne: async () => (H.doc ? JSON.parse(JSON.stringify(H.doc)) : null),
		},
	},
}));
// A template that writes each turn as "role: content", so the test reads what reached the prompt.
const MODEL = vi.hoisted(() => ({
	id: "test-model",
	name: "test-model",
	parameters: {},
	chatPromptRender: ({ messages, preprompt }: { messages: { role: string; content: string }[]; preprompt?: string }) =>
		[preprompt ? `system: ${preprompt}` : "", ...messages.map((m) => `${m.role}: ${m.content}`)].filter(Boolean).join("\n"),
}));
vi.mock("$lib/chat/server/models", () => ({ defaultModel: MODEL }));
vi.mock("$lib/chat/server/localModels", () => ({ getEffectiveModels: async () => [MODEL] }));
vi.mock("$lib/chat/server/textGeneration/turnPreferences", () => ({
	effectivePreprompt: (p?: string) => p,
	resolveTurnPreferences: async () => ({}),
}));

import { GET, POST } from "./+server";
import { slotMac } from "$lib/chat/server/chat/sealedTurn";

// Invented ids, secret and words.
const CONV = "6543210fedcba98765432100";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const MAC_KEY_HEX = "33".repeat(32);
const CANARY = "canary-heron-4964";
const QUESTION = `Where do herons nest? ${CANARY}`;
const ANSWER = `In colonies called heronries. ${CANARY}`;

const key = () => Buffer.from(MAC_KEY_HEX, "hex");
const bodyOf = (content: string) => ({ content });
const sealedMsg = (id: string, from: Message["from"], ancestors: string[], children: string[], content: string): Message =>
	({
		id,
		from,
		content: "",
		ancestors,
		children,
		sealed: "age-blob",
		sealedRev: 0,
		sealedMac: slotMac(key(), { kind: "message", conversationId: CONV, messageId: id, rev: 0 }, bodyOf(content)),
	}) as Message;

// Message ids must be UUIDs (isMessageId).
const S = "00000000-0000-4000-8000-000000000001";
const Q = "00000000-0000-4000-8000-000000000002";
const A = "00000000-0000-4000-8000-000000000003";

function sealedDoc() {
	return {
		_id: CONV,
		userId: USER,
		title: "",
		model: "test-model",
		preprompt: "",
		rootMessageId: S,
		messages: [
			{ id: S, from: "system", content: "", ancestors: [], children: [Q] },
			sealedMsg(Q, "user", [S], [A], QUESTION),
			sealedMsg(A, "assistant", [S, Q], [], ANSWER),
		],
	};
}

const locals = { user: { _id: { toString: () => USER } } } as unknown as App.Locals;
const url = `http://localhost/chat/conversation/${CONV}/message/${A}/prompt`;
const get = () => GET({ params: { id: CONV, messageId: A }, locals } as unknown as Parameters<typeof GET>[0]);
const post = (body: unknown) =>
	POST({
		params: { id: CONV, messageId: A },
		locals,
		request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	} as unknown as Parameters<typeof POST>[0]);
const opened = (answer = ANSWER) => [
	{ id: Q, rev: 0, body: bodyOf(QUESTION) },
	{ id: A, rev: 0, body: bodyOf(answer) },
];

beforeEach(() => {
	Object.assign(H.cfg, { CONVERSATION_HISTORY_MAC_KEY: MAC_KEY_HEX });
	H.doc = sealedDoc();
});

describe("message prompt view of a sealed chat", () => {
	it("refuses a GET (409, reason sealed) rather than return a prompt built from the empty stored skeletons", async () => {
		await expect(get()).rejects.toMatchObject({ status: 409, body: { reason: "sealed" } });
	});

	it("rebuilds the prompt from the bodies the browser opened, once each matches its stored MAC", async () => {
		const res = await post({ history: opened() });
		expect(res.status).toBe(200);
		const out = (await res.json()) as { prompt: string; messages: { role: string; content: string }[] };
		expect(out.prompt).toContain(`user: ${QUESTION}`);
		expect(out.prompt).toContain(`assistant: ${ANSWER}`);
		expect(out.messages.map((m) => m.content)).toEqual(["", QUESTION, ANSWER]);
	});

	it("refuses a body whose words differ from what was sealed (409)", async () => {
		await expect(post({ history: opened("Forged answer.") })).rejects.toMatchObject({ status: 409 });
	});

	it("refuses a POST without the opened bodies (409), rather than rebuild an empty prompt", async () => {
		await expect(post({})).rejects.toMatchObject({ status: 409 });
	});

	it("still answers a GET on a plaintext chat from the stored text", async () => {
		H.doc = {
			...sealedDoc(),
			messages: [
				{ id: S, from: "system", content: "", ancestors: [], children: [Q] },
				{ id: Q, from: "user", content: "plain question", ancestors: [S], children: [A] },
				{ id: A, from: "assistant", content: "plain answer", ancestors: [S, Q], children: [] },
			],
		};
		const res = await get();
		const out = (await res.json()) as { prompt: string };
		expect(out.prompt).toContain("user: plain question");
		expect(out.prompt).toContain("assistant: plain answer");
	});
});

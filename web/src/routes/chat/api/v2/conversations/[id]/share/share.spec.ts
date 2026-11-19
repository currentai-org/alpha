import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "$lib/chat/types/Message";

// Sharing a sealed chat is a release: the owner's browser posts each sealed message's opened
// body, the route checks each against its stored MAC, and the snapshot is built from the checked text.
// The conversation row is only read here, so it stays sealed. The MAC is the real one under an invented
// key; the store and the share table are stand-ins.

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string | undefined>,
	doc: null as Record<string, unknown> | null,
	shared: [] as { conversation: { title: string; messages: Message[] }; leafId?: string }[],
	writes: 0,
}));
vi.mock("$lib/chat/server/config", () => ({ config: H.cfg }));
vi.mock("$lib/chat/server/shareLinksGate", () => ({ shareLinksEnabled: () => true }));
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		conversations: {
			findOne: async () => (H.doc ? JSON.parse(JSON.stringify(H.doc)) : null),
			updateOne: async () => {
				H.writes++;
			},
			modifyOne: async () => {
				H.writes++;
			},
		},
	},
}));
vi.mock("$lib/chat/server/share/sharedConversations", () => ({
	shareConversation: async (_userId: string, conversation: { title: string; messages: Message[] }, leafId?: string) => {
		H.shared.push({ conversation, leafId });
		return { id: "tok", conversationId: CONV };
	},
	shareForConversation: async () => null,
	revokeShareForConversation: async () => false,
}));

import { POST } from "./+server";
import { buildShareSnapshot } from "$lib/chat/server/share/snapshot";
import { slotMac } from "$lib/chat/server/chat/sealedTurn";

// Invented ids, secret and words.
const CONV = "6543210fedcba98765432100";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const MAC_KEY_HEX = "22".repeat(32);
const CANARY = "canary-osprey-4963";

const key = () => Buffer.from(MAC_KEY_HEX, "hex");
const bodyOf = (content: string) => ({ content });
const sealedMsg = (id: string, from: Message["from"], ancestors: string[], content: string): Message =>
	({
		id,
		from,
		content: "",
		ancestors,
		children: [],
		sealed: "age-blob",
		sealedRev: 0,
		sealedMac: slotMac(key(), { kind: "message", conversationId: CONV, messageId: id, rev: 0 }, bodyOf(content)),
	}) as Message;

const QUESTION = `Where do ospreys winter? ${CANARY}`;
const ANSWER = `West Africa, mostly. ${CANARY}`;

function storedDoc() {
	return {
		_id: CONV,
		userId: USER,
		title: "",
		sealedTitle: "age-title",
		sealedTitleRev: 0,
		model: "test-model",
		messages: [
			{ id: "s", from: "system", content: "", ancestors: [], children: ["q"] },
			sealedMsg("q", "user", ["s"], QUESTION),
			sealedMsg("a", "assistant", ["s", "q"], ANSWER),
		],
	};
}

type Event = Parameters<typeof POST>[0];
const post = (body: unknown) =>
	POST({
		params: { id: CONV },
		locals: { user: { _id: { toString: () => USER } } } as unknown as App.Locals,
		request: new Request(`http://localhost/chat/api/v2/conversations/${CONV}/share`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as unknown as Event);

const opened = (overrides: Record<string, string> = {}) => [
	{ id: "q", rev: 0, body: bodyOf(overrides.q ?? QUESTION) },
	{ id: "a", rev: 0, body: bodyOf(overrides.a ?? ANSWER) },
];

beforeEach(() => {
	Object.assign(H.cfg, { CONVERSATION_HISTORY_MAC_KEY: MAC_KEY_HEX });
	H.doc = storedDoc();
	H.shared = [];
	H.writes = 0;
});

describe("POST conversations/[id]/share for a sealed chat", () => {
	it("builds the snapshot from the opened bodies the MAC accepts and the title the owner sent, writing nothing to the conversation", async () => {
		const res = await post({ history: opened(), title: `Ospreys ${CANARY}` });
		expect(res.status).toBe(200);
		expect(H.shared).toHaveLength(1);
		const snapshot = buildShareSnapshot(H.shared[0].conversation as never, undefined);
		expect(snapshot.title).toBe(`Ospreys ${CANARY}`);
		expect(snapshot.turns).toEqual([
			{ from: "user", content: QUESTION },
			{ from: "assistant", content: ANSWER },
		]);
		expect(H.writes, "the share wrote to the conversation row").toBe(0);
	});

	it("refuses a body whose words differ from what was sealed (409), and shares nothing", async () => {
		await expect(post({ history: opened({ a: "Forged answer." }), title: "x" })).rejects.toMatchObject({ status: 409 });
		expect(H.shared).toHaveLength(0);
	});

	it("refuses a sealed chat posted without its opened bodies, rather than sharing it empty", async () => {
		await expect(post({ title: "x" })).rejects.toMatchObject({ status: 409 });
		expect(H.shared).toHaveLength(0);
	});

	it("refuses with 503 when this deployment has no MAC key to check the bodies with", async () => {
		H.cfg.CONVERSATION_HISTORY_MAC_KEY = "";
		await expect(post({ history: opened(), title: "x" })).rejects.toMatchObject({ status: 503 });
		expect(H.shared).toHaveLength(0);
	});

	it("shares a plaintext chat as before, from the stored text, ignoring a posted title", async () => {
		H.doc = {
			_id: CONV,
			userId: USER,
			title: "Plain title",
			model: "test-model",
			messages: [{ id: "q", from: "user", content: "plain question", ancestors: [], children: [] }],
		};
		const res = await post({ title: "Not this" });
		expect(res.status).toBe(200);
		expect(H.shared[0].conversation.title).toBe("Plain title");
	});
});

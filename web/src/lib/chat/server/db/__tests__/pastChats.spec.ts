/**
 * past-chat search reads one account's own chats and nothing else. These run against the
 * real Postgres schema, because the owner filter and the message projection are SQL over the stored
 * document. Every chat here is written by the test. (CUR-4576)
 */
import { describe, expect, it, afterEach } from "vitest";
import { readPastChats } from "$lib/chat/server/db/pastChats";
import { searchPastChats } from "$lib/chat/server/rag/pastChats";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

const msg = (from: "user" | "assistant" | "system", content: string, extra: Record<string, unknown> = {}) =>
	({ id: crypto.randomUUID(), from, content, children: [], ...extra }) as unknown as Message;

afterEach(cleanupTestData);

describe("past-chat search tenant scoping (CUR-4576)", () => {
	it("never returns another account's chat or a guest's chat, even when it matches the query best", async () => {
		const alice = await createTestUser();
		const bob = await createTestUser();
		await createTestConversation(alice.locals, {
			title: "Alice's garden",
			messages: [msg("user", "I grow tomatoes on the balcony.")],
		});
		await createTestConversation(bob.locals, {
			title: "Bob's secret",
			messages: [msg("user", "My bank PIN hint is pancake pancake pancake.")],
		});
		const guestLocals = { ...alice.locals, user: undefined, sessionId: `guest-${crypto.randomUUID()}` };
		await createTestConversation(guestLocals, {
			title: "guest pancake chat",
			messages: [msg("user", "pancake recipe")],
		});

		const aliceId = alice.user._id.toString();
		const read = await readPastChats(aliceId);
		expect(read.map((c) => c.title)).toEqual(["Alice's garden"]);
		expect(await searchPastChats("pancake", { userId: aliceId })).toBeNull();

		const bobHits = await searchPastChats("pancake", { userId: bob.user._id.toString() });
		expect(bobHits?.sources.map((s) => s.title)).toEqual(["Bob's secret"]);
	});

	it("gives a guest nothing, and reads no chat without an owner", async () => {
		expect(await searchPastChats("pancake", { userId: undefined })).toBeNull();
		expect(await readPastChats("")).toEqual([]);
	});

	it("leaves out the chat the turn is in, and every message a screen flagged", async () => {
		const { locals } = await createTestUser();
		const current = await createTestConversation(locals, {
			title: "Now",
			messages: [msg("user", "kumquat in the current chat")],
		});
		await createTestConversation(locals, {
			title: "Earlier",
			messages: [
				msg("system", "kumquat system prompt"),
				msg("user", "kumquat declined request", { moderation: { flagged: true, label: "x", score: 1, kind: "input" } }),
				msg("assistant", "kumquat withheld answer", { outputModeration: { flagged: true, label: "x", score: 1 } }),
				msg("user", "a kumquat is a small citrus fruit"),
				msg("assistant", "<think>private reasoning</think>Yes, kumquats are eaten whole."),
			],
		});

		const chats = await readPastChats(locals.user!._id.toString(), current._id.toString());
		expect(chats.map((c) => c.title)).toEqual(["Earlier"]);
		expect(chats[0].messages).toEqual([
			{ from: "user", content: "a kumquat is a small citrus fruit" },
			{ from: "assistant", content: "Yes, kumquats are eaten whole." },
		]);
	});
});

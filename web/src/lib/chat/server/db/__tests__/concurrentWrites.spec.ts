/**
 * Writes to one conversation that overlap must not erase each other. Each pair below runs
 * concurrently against the real database. Each would lose a write if an update read the whole
 * document and wrote its own copy of all of it back. (CUR-2806)
 */
import { describe, expect, it, afterEach } from "vitest";
import { ObjectId } from "bson";
import { collections } from "$lib/chat/server/database";
import type { Conversation } from "$lib/chat/types/Conversation";
import type { Message } from "$lib/chat/types/Message";
import { cleanupTestData } from "$lib/chat/server/api/__tests__/testHelpers";
import { saveConversationMessages, snapshotConversation } from "$lib/chat/server/chat/conversationWrites";

const root: Message = { id: "root", from: "system", content: "", ancestors: [], children: [] };

function turn(q: string, a: string, answer: string): Message[] {
	return [
		{ id: q, from: "user", content: `${q} asks`, ancestors: ["root"], children: [a] },
		{ id: a, from: "assistant", content: answer, ancestors: ["root", q], children: [] },
	];
}

async function seed(): Promise<Conversation> {
	const conv = {
		_id: new ObjectId(),
		title: "seeded",
		model: "test-model",
		sessionId: "sess-concurrent-writes",
		createdAt: new Date(),
		updatedAt: new Date(),
		rootMessageId: "root",
		messages: [root],
	} as unknown as Conversation;
	await collections.conversations.insertOne(conv);
	return conv;
}

describe.sequential("concurrent writes to one conversation", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("keeps both updates when two land at once on different fields", async () => {
		const conv = await seed();
		await Promise.all([
			collections.conversations.updateOne({ _id: conv._id }, { $set: { title: "renamed" } }),
			collections.conversations.updateOne(
				{ _id: conv._id },
				{ $set: { messages: [{ ...root, children: ["q"] }, ...turn("q", "a", "answer")] } }
			),
		]);

		const stored = await collections.conversations.findOne({ _id: conv._id });
		expect(stored?.title).toBe("renamed");
		expect(stored?.messages.map((m) => m.id)).toEqual(["root", "q", "a"]);
	});

	it("keeps both turns when two requests that loaded the same copy save at once", async () => {
		const conv = await seed();
		const base = snapshotConversation(conv);
		const save = (q: string, a: string) =>
			saveConversationMessages({ _id: conv._id }, base, {
				messages: [{ ...root, children: [q] }, ...turn(q, a, `${a} text`)],
				updatedAt: new Date(),
			});
		await Promise.all([save("qA", "aA"), save("qB", "aB")]);

		const stored = await collections.conversations.findOne({ _id: conv._id });
		expect(stored?.messages.map((m) => m.id).sort()).toEqual(["aA", "aB", "qA", "qB", "root"]);
		expect(stored?.messages.find((m) => m.id === "root")?.children?.sort()).toEqual(["qA", "qB"]);
		expect(stored?.messages.find((m) => m.id === "aA")?.content).toBe("aA text");
		expect(stored?.messages.find((m) => m.id === "aB")?.content).toBe("aB text");
	});

	it("keeps a rename made while a turn was running, and the turn's messages", async () => {
		const conv = await seed();
		const base = snapshotConversation(conv);
		await collections.conversations.updateOne({ _id: conv._id }, { $set: { title: "renamed" } });
		await saveConversationMessages({ _id: conv._id }, base, {
			messages: [{ ...root, children: ["q"] }, ...turn("q", "a", "answer")],
			title: conv.title,
			updatedAt: new Date(),
		});

		const stored = await collections.conversations.findOne({ _id: conv._id });
		expect(stored?.title).toBe("renamed");
		expect(stored?.messages.map((m) => m.id)).toEqual(["root", "q", "a"]);
	});

	it("drops a field set to undefined, as writing the whole document back did", async () => {
		const conv = await seed();
		await collections.conversations.updateOne({ _id: conv._id }, { $set: { title: undefined } });

		const stored = await collections.conversations.findOne({ _id: conv._id });
		expect(stored && "title" in stored).toBe(false);
		expect(stored?.messages.map((m) => m.id)).toEqual(["root"]);
	});
});

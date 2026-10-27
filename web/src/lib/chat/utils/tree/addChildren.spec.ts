import { collections } from "$lib/chat/server/database";
import { ObjectId } from "bson";
import { describe, expect, it } from "vitest";

import { insertLegacyConversation, insertSideBranchesConversation } from "./treeHelpers";
import { addChildren } from "./addChildren";
import type { Message } from "$lib/chat/types/Message";

const newMessage: Omit<Message, "id"> = {
	content: "new message",
	from: "user",
};

Object.freeze(newMessage);

describe("addChildren", async () => {
	it("should let you append on legacy conversations", async () => {
		const convId = await insertLegacyConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		const convLength = conv.messages.length;

		addChildren(conv, newMessage, conv.messages[conv.messages.length - 1].id);
		expect(conv.messages.length).toEqual(convLength + 1);
	});
	it("should not let you create branches on legacy conversations", async () => {
		const convId = await insertLegacyConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		expect(() => addChildren(conv, newMessage, conv.messages[0].id)).toThrow();
	});
	it("should not let you create a message that already exists", async () => {
		const convId = await insertLegacyConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		const messageThatAlreadyExists: Message = {
			id: conv.messages[0].id,
			content: "new message",
			from: "user",
		};

		expect(() => addChildren(conv, messageThatAlreadyExists, conv.messages[0].id)).toThrow();
	});
	it("should let you create branches on conversations with subtrees", async () => {
		const convId = await insertSideBranchesConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		const nChildren = conv.messages[0].children?.length;
		if (!nChildren) throw new Error("No children found");
		addChildren(conv, newMessage, conv.messages[0].id);
		expect(conv.messages[0].children?.length).toEqual(nChildren + 1);
	});

	it("should let you create a new leaf", async () => {
		const convId = await insertSideBranchesConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		const parentId = conv.messages[conv.messages.length - 1].id;
		const nChildren = conv.messages[conv.messages.length - 1].children?.length;

		if (nChildren === undefined) throw new Error("No children found");
		expect(nChildren).toEqual(0);

		addChildren(conv, newMessage, parentId);
		expect(conv.messages[conv.messages.length - 2].children?.length).toEqual(nChildren + 1);
	});

	it("should let you append to an empty conversation without specifying a parentId", async () => {
		const conv = {
			_id: new ObjectId(),
			rootMessageId: undefined,
			messages: [] as Message[],
		};

		addChildren(conv, newMessage);
		expect(conv.messages.length).toEqual(1);
		expect(conv.rootMessageId).toEqual(conv.messages[0].id);
	});

	it("should throw if you don't specify a parentId in a conversation with messages", async () => {
		const convId = await insertLegacyConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		expect(() => addChildren(conv, newMessage)).toThrow();
	});

	it("should return the id of the new message", async () => {
		const convId = await insertLegacyConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");

		expect(addChildren(conv, newMessage, conv.messages[conv.messages.length - 1].id)).toEqual(
			conv.messages[conv.messages.length - 1].id
		);
	});
	// The page and the server build the same turn; a caller-chosen id keeps them equal. (CUR-2098)
	it("uses the caller's id for the new message when one is given", async () => {
		const convId = await insertSideBranchesConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");
		const id = "33333333-3333-4333-8333-333333333333";
		expect(addChildren(conv, newMessage, conv.messages[conv.messages.length - 1].id, id)).toBe(id);
		expect(conv.messages.at(-1)?.id).toBe(id);
	});
	it("refuses a caller's id that is already in the conversation, rather than making two messages with one id", async () => {
		const convId = await insertSideBranchesConversation();
		const conv = await collections.conversations.findOne({ _id: new ObjectId(convId) });
		if (!conv) throw new Error("Conversation not found");
		const existing = conv.messages[0].id;
		expect(() => addChildren(conv, newMessage, conv.messages[conv.messages.length - 1].id, existing)).toThrow(
			"already exists"
		);
	});
});

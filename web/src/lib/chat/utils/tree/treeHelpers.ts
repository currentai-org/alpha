import { getCollectionsEarly } from "$lib/chat/server/database";
import { ObjectId } from "bson";

// Shared fixtures for tree/*.spec.ts — kept outside *.spec.ts so importing helpers
// does not re-register Vitest tests in each consumer file.
const getConversations = async () => (await getCollectionsEarly()).conversations;

export const insertLegacyConversation = async () => {
	const conversations = await getConversations();
	const res = await conversations.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		title: "legacy conversation",
		model: "",

		messages: [
			{
				id: "1-1-1-1-1",
				from: "user",
				content: "Hello, world! I am a user",
			},
			{
				id: "1-1-1-1-2",
				from: "assistant",
				content: "Hello, world! I am an assistant.",
			},
			{
				id: "1-1-1-1-3",
				from: "user",
				content: "Hello, world! I am a user.",
			},
			{
				id: "1-1-1-1-4",
				from: "assistant",
				content: "Hello, world! I am an assistant.",
			},
		],
	});
	return res.insertedId;
};

export const insertLinearBranchConversation = async () => {
	const conversations = await getConversations();
	const res = await conversations.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		title: "linear branch conversation",
		model: "",

		rootMessageId: "1-1-1-1-1",
		messages: [
			{
				id: "1-1-1-1-1",
				from: "user",
				content: "Hello, world! I am a user",
				ancestors: [],
				children: ["1-1-1-1-2"],
			},
			{
				id: "1-1-1-1-2",
				from: "assistant",
				content: "Hello, world! I am an assistant.",
				ancestors: ["1-1-1-1-1"],
				children: ["1-1-1-1-3"],
			},
			{
				id: "1-1-1-1-3",
				from: "user",
				content: "Hello, world! I am a user.",
				ancestors: ["1-1-1-1-1", "1-1-1-1-2"],
				children: ["1-1-1-1-4"],
			},
			{
				id: "1-1-1-1-4",
				from: "assistant",
				content: "Hello, world! I am an assistant.",
				ancestors: ["1-1-1-1-1", "1-1-1-1-2", "1-1-1-1-3"],
				children: [],
			},
		],
	});
	return res.insertedId;
};

export const insertSideBranchesConversation = async () => {
	const conversations = await getConversations();
	const res = await conversations.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		title: "side branches conversation",
		model: "",

		rootMessageId: "1-1-1-1-1",
		messages: [
			{
				id: "1-1-1-1-1",
				from: "user",
				content: "Hello, world, root message!",
				ancestors: [],
				children: ["1-1-1-1-2", "1-1-1-1-5"],
			},
			{
				id: "1-1-1-1-2",
				from: "assistant",
				content: "Hello, response to root message!",
				ancestors: ["1-1-1-1-1"],
				children: ["1-1-1-1-3"],
			},
			{
				id: "1-1-1-1-3",
				from: "user",
				content: "Hello, follow up question!",
				ancestors: ["1-1-1-1-1", "1-1-1-1-2"],
				children: ["1-1-1-1-4"],
			},
			{
				id: "1-1-1-1-4",
				from: "assistant",
				content: "Hello, response from follow up question!",
				ancestors: ["1-1-1-1-1", "1-1-1-1-2", "1-1-1-1-3"],
				children: [],
			},
			{
				id: "1-1-1-1-5",
				from: "assistant",
				content: "Hello, alternative assistant answer!",
				ancestors: ["1-1-1-1-1"],
				children: ["1-1-1-1-6", "1-1-1-1-7"],
			},
			{
				id: "1-1-1-1-6",
				from: "user",
				content: "Hello, follow up question to alternative answer!",
				ancestors: ["1-1-1-1-1", "1-1-1-1-5"],
				children: [],
			},
			{
				id: "1-1-1-1-7",
				from: "user",
				content: "Hello, alternative follow up question to alternative answer!",
				ancestors: ["1-1-1-1-1", "1-1-1-1-5"],
				children: [],
			},
		],
	});
	return res.insertedId;
};

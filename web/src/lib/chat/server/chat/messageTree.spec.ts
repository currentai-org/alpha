import { describe, expect, it } from "vitest";
import type { Conversation } from "$lib/chat/types/Conversation";
import { addChildren } from "$lib/chat/utils/tree/addChildren.js";
import { appendTurnMessages } from "./messageTree";

// Minimal in-memory conversation (only the tree fields appendTurnMessages touches).
function emptyConv(): Conversation {
	return { messages: [], rootMessageId: undefined } as unknown as Conversation;
}

function turn(conv: Conversation, content: string, from: "user" | "assistant", parentId?: string) {
	return addChildren(
		conv,
		{ from, content, createdAt: new Date(), updatedAt: new Date() },
		parentId
	);
}

// Seed a two-turn conversation (user1 → assistant1 → user2 → assistant2). Two turns so the
// "edit a user message" case targets a NON-root user message (the root can't take a sibling).
function seededConv() {
	const conv = emptyConv();
	const rootId = turn(conv, "hello", "user");
	conv.rootMessageId = rootId;
	const assistant1 = turn(conv, "hi there", "assistant", rootId);
	const userId = turn(conv, "follow up", "user", assistant1);
	const assistantId = turn(conv, "an answer", "assistant", userId);
	return { conv, rootId, userId, assistantId };
}

describe("appendTurnMessages", () => {
	it("normal turn appends a user message and a blank assistant child", () => {
		const { conv, assistantId } = seededConv();
		const before = conv.messages.length;

		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			// a normal turn always carries the parent (leaf) message id from the client
			messageId: assistantId,
			newPrompt: "second question",
			uploadedFiles: [],
		});

		// two new messages (user + assistant) added
		expect(conv.messages.length).toBe(before + 2);
		const writeTo = conv.messages.find((m) => m.id === messageToWriteToId);
		expect(writeTo?.from).toBe("assistant");
		expect(writeTo?.content).toBe("");
		// the prompt subtree ends on the new user message, not the blank assistant
		expect(messagesForPrompt.at(-1)?.from).toBe("user");
		expect(messagesForPrompt.at(-1)?.content).toBe("second question");
	});

	it("retrying an assistant message adds a sibling and drops the old answer from the prompt", () => {
		const { conv, assistantId } = seededConv();

		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			isRetry: true,
			messageId: assistantId,
			uploadedFiles: [],
		});

		const writeTo = conv.messages.find((m) => m.id === messageToWriteToId);
		expect(writeTo?.from).toBe("assistant");
		expect(writeTo?.id).not.toBe(assistantId); // a fresh sibling, not the original
		// the assistant message being retried is not part of the prompt
		expect(messagesForPrompt.some((m) => m.id === assistantId)).toBe(false);
		expect(messagesForPrompt.at(-1)?.from).toBe("user");
	});

	it("editing a user message (retry with newPrompt) forks a user sibling + blank assistant", () => {
		const { conv, userId } = seededConv();

		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			isRetry: true,
			messageId: userId,
			newPrompt: "edited question",
			uploadedFiles: [],
		});

		const writeTo = conv.messages.find((m) => m.id === messageToWriteToId);
		expect(writeTo?.from).toBe("assistant");
		expect(messagesForPrompt.at(-1)?.content).toBe("edited question");
	});

	it("throws 404 when retrying a message that does not exist", () => {
		const { conv } = seededConv();
		expect(() =>
			appendTurnMessages(conv, {
				isRetry: true,
				messageId: "00000000-0000-0000-0000-000000000000",
				uploadedFiles: [],
			})
		).toThrow();
	});

	// A normal (non-retry) turn whose parent ref is stale — a resend after an interrupted
	// generation left the client pointing at a message the server never persisted — must re-point
	// to the current leaf and land the turn, not build a dangling node and 500 with "Ancestor not
	// found" downstream in buildSubtree.
	it("re-points to the current leaf when a normal turn's parent reference is stale (no throw)", () => {
		const { conv } = seededConv();
		const before = conv.messages.length;
		const leafBefore = conv.messages[conv.messages.length - 1].id;

		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			messageId: "ghost-id-not-in-tree", // stale: not in conv.messages
			newPrompt: "still want an answer",
			uploadedFiles: [],
		});

		expect(messageToWriteToId).toBeDefined();
		expect(conv.messages.length).toBe(before + 2); // user + blank assistant appended, not orphaned
		// the new user message attached under the real leaf, and the prompt subtree built cleanly
		const newUser = messagesForPrompt.at(-1);
		expect(newUser?.from).toBe("user");
		expect(newUser?.content).toBe("still want an answer");
		expect(newUser?.ancestors).toContain(leafBefore);
		// no dangling ancestor id survives in the built subtree
		const ids = new Set(conv.messages.map((m) => m.id));
		for (const m of messagesForPrompt)
			for (const a of m.ancestors ?? []) expect(ids.has(a)).toBe(true);
	});
});

// The same conversation open in two tabs. Each page names the last message it has seen as the
// parent, so the second tab to send names a message the first tab's turn already hangs under. Its
// turn goes after the newest one, in order, instead of forking a hidden sibling ("1 / 2").
describe("appendTurnMessages — a second tab's turn follows the first, never forks", () => {
	function otherTabTurn(conv: Conversation, parent: string, answer: string) {
		const q = turn(conv, "tab A's question", "user", parent);
		const a = turn(conv, answer, "assistant", q);
		return { q, a };
	}

	it("a turn sent from a tab that missed an answered turn is appended after it", () => {
		const { conv, assistantId } = seededConv();
		const tabA = otherTabTurn(conv, assistantId, "tab A's answer");

		const { messagesForPrompt } = appendTurnMessages(conv, {
			messageId: assistantId, // tab B still thinks this is the end of the conversation
			newPrompt: "tab B's question",
			uploadedFiles: [],
		});

		const parent = conv.messages.find((m) => m.id === assistantId);
		expect(parent?.children).toEqual([tabA.q]); // no sibling beside tab A's question
		const newUser = messagesForPrompt.at(-1);
		expect(newUser?.content).toBe("tab B's question");
		expect(newUser?.ancestors?.at(-1)).toBe(tabA.a);
		expect(messagesForPrompt.map((m) => m.content)).toContain("tab A's answer");
	});

	it("a turn sent while the other tab's answer is still streaming queues after it and leaves that unanswered turn out of the prompt", () => {
		const { conv, assistantId } = seededConv();
		const tabA = otherTabTurn(conv, assistantId, ""); // saved blank, still being written

		const { messagesForPrompt } = appendTurnMessages(conv, {
			messageId: assistantId,
			newPrompt: "tab B's question",
			uploadedFiles: [],
		});

		const newUser = messagesForPrompt.at(-1);
		expect(newUser?.ancestors?.at(-1)).toBe(tabA.a);
		const ids = messagesForPrompt.map((m) => m.id);
		expect(ids).not.toContain(tabA.q);
		expect(ids).not.toContain(tabA.a);
		// roles still alternate, which some chat templates require
		const roles = messagesForPrompt.map((m) => m.from);
		for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
	});

	it("an edit from a tab that missed a turn still forks a sibling of the edited question", () => {
		const { conv, userId, assistantId } = seededConv();
		otherTabTurn(conv, assistantId, "tab A's answer");

		appendTurnMessages(conv, {
			isRetry: true,
			messageId: userId,
			newPrompt: "edited question",
			uploadedFiles: [],
		});

		const parentOfEdited = conv.messages.find((m) => m.id === userId)?.ancestors?.at(-1);
		const parent = conv.messages.find((m) => m.id === parentOfEdited);
		expect(parent?.children?.length).toBe(2);
	});

	it("a regenerate from a tab that missed a turn still forks a sibling answer", () => {
		const { conv, userId, assistantId } = seededConv();
		otherTabTurn(conv, assistantId, "tab A's answer");

		appendTurnMessages(conv, { isRetry: true, messageId: assistantId, uploadedFiles: [] });

		expect(conv.messages.find((m) => m.id === userId)?.children?.length).toBe(2);
	});
});

// CUR-2098. The page builds the same turn locally and sends the ids it minted. When the server uses
// them, its post-turn snapshot carries the page's ids and the page swaps it in without remounting
// the answer, so a trace or source list the person opened stays open.
describe("appendTurnMessages — adopts the page's ids so the answer isn't remounted (CUR-2098)", () => {
	const USER = "11111111-1111-4111-8111-111111111111";
	const ASSISTANT = "22222222-2222-4222-8222-222222222222";

	it("a normal turn uses the page's user and assistant ids", () => {
		const { conv, assistantId } = seededConv();
		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			messageId: assistantId,
			newPrompt: "second question",
			uploadedFiles: [],
			newMessageIds: { user: USER, assistant: ASSISTANT },
		});
		expect(messageToWriteToId).toBe(ASSISTANT);
		expect(messagesForPrompt.at(-1)?.id).toBe(USER);
		expect(conv.messages.find((m) => m.id === ASSISTANT)?.ancestors?.at(-1)).toBe(USER);
	});

	it("editing a user message uses the page's ids for the new user sibling and its answer", () => {
		const { conv, userId } = seededConv();
		const { messageToWriteToId } = appendTurnMessages(conv, {
			isRetry: true,
			messageId: userId,
			newPrompt: "edited",
			uploadedFiles: [],
			newMessageIds: { user: USER, assistant: ASSISTANT },
		});
		expect(messageToWriteToId).toBe(ASSISTANT);
		expect(conv.messages.find((m) => m.id === USER)?.content).toBe("edited");
	});

	it("regenerating an answer uses the page's assistant id", () => {
		const { conv, assistantId } = seededConv();
		const { messageToWriteToId } = appendTurnMessages(conv, {
			isRetry: true,
			messageId: assistantId,
			uploadedFiles: [],
			newMessageIds: { assistant: ASSISTANT },
		});
		expect(messageToWriteToId).toBe(ASSISTANT);
	});

	it("an id already in the conversation (a re-POST of the same turn) is not reused: a fresh one is minted and the turn still lands", () => {
		const { conv, assistantId } = seededConv();
		const { messageToWriteToId } = appendTurnMessages(conv, {
			messageId: assistantId,
			newPrompt: "second question",
			uploadedFiles: [],
			newMessageIds: { user: assistantId, assistant: ASSISTANT },
		});
		expect(messageToWriteToId).toBe(ASSISTANT);
		expect(new Set(conv.messages.map((m) => m.id)).size).toBe(conv.messages.length);
	});

	it("the same id sent for both messages is used once, never twice", () => {
		const { conv, assistantId } = seededConv();
		const { messageToWriteToId } = appendTurnMessages(conv, {
			messageId: assistantId,
			newPrompt: "second question",
			uploadedFiles: [],
			newMessageIds: { user: USER, assistant: USER },
		});
		expect(messageToWriteToId).not.toBe(USER);
		expect(new Set(conv.messages.map((m) => m.id)).size).toBe(conv.messages.length);
	});

	it("no ids from the page (an older client) mints fresh ones, as before", () => {
		const { conv, assistantId } = seededConv();
		const { messageToWriteToId } = appendTurnMessages(conv, {
			messageId: assistantId,
			newPrompt: "second question",
			uploadedFiles: [],
		});
		expect(messageToWriteToId).toMatch(/^[0-9a-f-]{36}$/);
	});
});

describe("appendTurnMessages — re-attaching to an agent task (CUR-993)", () => {
	function withAgentRun(run: { taskId: string; closed?: boolean } | undefined) {
		const seeded = seededConv();
		const answer = seeded.conv.messages.find((m) => m.id === seeded.assistantId)!;
		Object.assign(answer, { agentRun: run, interrupted: true, content: "Stopped early." });
		return { ...seeded, answer };
	}

	it("rewrites the interrupted answer in place: no new message, emptied, and left out of the prompt", () => {
		const { conv, assistantId, answer } = withAgentRun({ taskId: "t1" });
		const before = conv.messages.length;

		const { messageToWriteToId, messagesForPrompt } = appendTurnMessages(conv, {
			attach: true,
			messageId: assistantId,
			uploadedFiles: [],
		});

		expect(conv.messages.length).toBe(before);
		expect(messageToWriteToId).toBe(assistantId);
		expect(answer).toMatchObject({ content: "", interrupted: false, agentRun: { taskId: "t1" } });
		expect(messagesForPrompt.at(-1)?.content).toBe("follow up");
	});

	it("refuses (409) a message with no agent task, or one that is closed (stopped, or gone from agent-service), rather than generating anew", () => {
		for (const run of [undefined, { taskId: "t1", closed: true }]) {
			const { conv, assistantId, answer } = withAgentRun(run);
			expect(() =>
				appendTurnMessages(conv, { attach: true, messageId: assistantId, uploadedFiles: [] })
			).toThrow(expect.objectContaining({ status: 409 }));
			expect(answer.content).toBe("Stopped early.");
		}
	});
});

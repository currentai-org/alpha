import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveConversation's owner-mismatch branch logs the owner's actual sessionId/userId
// alongside the requester's, so a live occurrence names which identity won rather than only
// "cookie was present". Mirrors auth.betterAuthBridge.spec.ts's DB-mocking convention. (CUR-1315)
vi.mock("$lib/chat/server/database", () => ({
	collections: {
		conversations: {
			findOne: vi.fn(async () => null),
		},
	},
}));

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({
	logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveConversation } from "./resolveConversation";
import { collections } from "$lib/chat/server/database";
import { ObjectId } from "bson";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const conversationsFindOne = vi.mocked((collections as any).conversations.findOne);

const id = new ObjectId().toHexString();
const anonLocals = (sessionId: string) => ({ sessionId, user: undefined }) as unknown as App.Locals;

describe("resolveConversation — 403 identity logging (CUR-1315)", () => {
	beforeEach(() => {
		conversationsFindOne.mockReset();
		warn.mockReset();
	});

	it("answers another session's conversation with the same 404 as a missing one, and logs both identities", async () => {
		conversationsFindOne
			.mockResolvedValueOnce(null) // the authCondition-scoped lookup: no match for this requester
			.mockResolvedValueOnce({ _id: new ObjectId(id), sessionId: "owner-session-hash", userId: undefined }); // the bare existence re-check

		// Still a 404 with the same message as a missing id, so the answer reveals nothing. (CUR-3523)
		await expect(resolveConversation(id, anonLocals("requester-session-hash"))).rejects.toMatchObject({
			status: 404,
			body: { message: "Conversation not found." },
		});

		expect(warn).toHaveBeenCalledTimes(1);
		const [fields, message] = warn.mock.calls[0];
		expect(message).toContain("[auth][CUR-1315]");
		expect(fields).toMatchObject({
			conversationId: id,
			requesterSessionId: "requester-session-hash",
			ownerSessionId: "owner-session-hash",
		});
	});

	it("does not log when the conversation genuinely does not exist", async () => {
		conversationsFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

		await expect(resolveConversation(id, anonLocals("requester-session-hash"))).rejects.toMatchObject({
			status: 404,
		});

		expect(warn).not.toHaveBeenCalled();
	});

	it("does not log on the ordinary success path — matching identity, no denial at all", async () => {
		conversationsFindOne.mockResolvedValueOnce({
			_id: new ObjectId(id),
			sessionId: "same-session-hash",
			messages: [],
		});

		const result = await resolveConversation(id, anonLocals("same-session-hash"));

		expect(result.sessionId).toBe("same-session-hash");
		expect(warn).not.toHaveBeenCalled();
	});
});

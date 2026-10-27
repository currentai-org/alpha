import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "bson";

// Mock the DB seam + auth/convert helpers so the load/authorize/migrate branches are deterministic.
const { findOne, updateOne, authCondition, convertLegacyConversation } = vi.hoisted(() => ({
	findOne: vi.fn(),
	updateOne: vi.fn(),
	authCondition: vi.fn(() => ({ sessionId: "s1" })),
	convertLegacyConversation: vi.fn(() => ({ rootMessageId: "root", messages: [] })),
}));

vi.mock("$lib/chat/server/database", () => ({
	collections: { conversations: { findOne, updateOne } },
}));
vi.mock("$lib/chat/server/auth", () => ({ authCondition }));
vi.mock("$lib/chat/utils/tree/convertLegacyConversation", () => ({ convertLegacyConversation }));

import { loadAuthorizedConversation } from "./loadConversation";

const convId = new ObjectId();
const locals = { sessionId: "s1", isAdmin: false } as unknown as App.Locals;

beforeEach(() => {
	findOne.mockReset();
	updateOne.mockReset().mockResolvedValue({ acknowledged: true });
	authCondition.mockReset().mockReturnValue({ sessionId: "s1" });
	convertLegacyConversation.mockReset().mockReturnValue({ rootMessageId: "root", messages: [] });
});

describe("loadAuthorizedConversation", () => {
	it("returns the conversation when it exists with a tree shape (no migration)", async () => {
		const conv = { _id: convId, rootMessageId: "root", messages: [] };
		findOne.mockResolvedValue(conv);
		await expect(loadAuthorizedConversation({ convId, locals })).resolves.toBe(conv);
		// already tree-shaped → no migration write
		expect(updateOne).not.toHaveBeenCalled();
	});

	it("migrates a legacy (rootMessageId-less) conversation, then returns the migrated doc", async () => {
		const legacy = { _id: convId, messages: [{ id: "m" }] }; // no rootMessageId
		const migrated = { _id: convId, rootMessageId: "root", messages: [] };
		findOne.mockResolvedValueOnce(legacy).mockResolvedValueOnce(migrated);
		await expect(loadAuthorizedConversation({ convId, locals })).resolves.toBe(migrated);
		expect(convertLegacyConversation).toHaveBeenCalledWith(legacy);
		expect(updateOne).toHaveBeenCalledTimes(1);
	});

	it("throws 500 when the legacy migration write is not acknowledged", async () => {
		findOne.mockResolvedValue({ _id: convId, messages: [] }); // legacy
		updateOne.mockResolvedValue({ acknowledged: false });
		await expect(loadAuthorizedConversation({ convId, locals })).rejects.toMatchObject({
			status: 500,
		});
	});

	it("throws 404 when no conversation matches the auth-scoped query", async () => {
		findOne.mockResolvedValue(null);
		await expect(loadAuthorizedConversation({ convId, locals })).rejects.toMatchObject({
			status: 404,
		});
	});

	it("scopes every lookup with authCondition (no cross-user reads)", async () => {
		findOne.mockResolvedValue({ _id: convId, rootMessageId: "root", messages: [] });
		await loadAuthorizedConversation({ convId, locals });
		expect(authCondition).toHaveBeenCalledWith(locals);
		expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s1" }));
	});
});

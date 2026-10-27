import { describe, it, expect, vi, beforeEach } from "vitest";

const { moveGuestFilesToUser } = vi.hoisted(() => ({ moveGuestFilesToUser: vi.fn(async () => undefined) }));
vi.mock("$lib/chat/server/storage/custodialStorage", () => ({ moveGuestFilesToUser }));
vi.mock("$lib/chat/server/vercelBackground", () => ({ runInBackground: (p: Promise<unknown>) => p }));

vi.mock("$lib/chat/server/database", () => ({
	collections: {
		conversations: { updateMany: vi.fn(async () => ({ matchedCount: 0 })) },
		settings: {
			updateOne: vi.fn(async () => ({ matchedCount: 0 })),
			insertOne: vi.fn(async () => ({})),
			findOne: vi.fn(async () => null),
		},
	},
}));

import { collections } from "$lib/chat/server/database";
import { migrateAnonymousConversations, migrateAnonymousSettings } from "./migrateAnonymousSession";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const settings = (collections as any).settings;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const conversations = (collections as any).conversations;
const userId = "user-1" as unknown as Parameters<typeof migrateAnonymousSettings>[1];
const duplicateKey = new Error('duplicate key value violates unique constraint "settings_user_idx"');

beforeEach(() => {
	vi.clearAllMocks();
});

// Two requests carrying a new user's first session both seed defaults, and the second
// insert hits the unique key on userId. (CUR-2607)
describe("migrateAnonymousSettings, when a concurrent first-login request seeds the same user", () => {
	it("resolves when its insert fails and the other request's settings row is there", async () => {
		settings.insertOne.mockRejectedValueOnce(duplicateKey);
		settings.findOne.mockResolvedValueOnce({ userId });

		await expect(migrateAnonymousSettings(undefined, userId)).resolves.toBeUndefined();
		expect(settings.findOne).toHaveBeenCalledWith({ userId });
	});

	it("rethrows the insert's own error when no settings row exists for the user afterwards", async () => {
		settings.insertOne.mockRejectedValueOnce(duplicateKey);
		settings.findOne.mockResolvedValueOnce(null);

		await expect(migrateAnonymousSettings(undefined, userId)).rejects.toBe(duplicateKey);
	});

	it("never re-reads when the insert succeeds", async () => {
		await migrateAnonymousSettings(undefined, userId);

		expect(settings.insertOne).toHaveBeenCalledTimes(1);
		expect(settings.findOne).not.toHaveBeenCalled();
	});
});

// The session's attachments follow its conversations, and this is the last place that
// still knows the session id. (CUR-2183)
describe("migrateAnonymousConversations moves the session's attachments to the account", () => {
	it("hands the session and the account to the move after re-keying the conversations", async () => {
		const sid = "c".repeat(64);
		conversations.updateMany.mockResolvedValueOnce({ matchedCount: 2 });
		await migrateAnonymousConversations(sid, userId);
		expect(moveGuestFilesToUser).toHaveBeenCalledWith(sid, "user-1");
	});

	// auth.ts runs this on every request a returning signed-in visitor makes, and the move
	// lists guests/<session>/ on Hugging Face before finding it empty, one shared-token call per page
	// load, poll and API call. A guest's files belong to its conversations, so none re-keyed means none
	// to move. (CUR-3682)
	it("makes no Hub call when no conversation was re-keyed, as on a signed-in visitor's every request", async () => {
		await migrateAnonymousConversations("d".repeat(64), userId);
		expect(moveGuestFilesToUser).not.toHaveBeenCalled();
	});

	it("moves nothing when there was no anonymous session", async () => {
		await migrateAnonymousConversations(undefined, userId);
		expect(moveGuestFilesToUser).not.toHaveBeenCalled();
	});
});

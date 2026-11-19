/**
 * Share links against real Postgres: one link per conversation that a refresh keeps, a
 * revoke that the viewer's read sees at once, and the three wipe paths (chat delete, Forget everything,
 * account delete) each leaving no live link for the account while another account's link survives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

// The bucket and agent-service are outside this database; the wipe reaches them through these.
vi.mock("$lib/chat/server/storage/custodialStorage", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/chat/server/storage/custodialStorage")>()),
	deleteCustodialFolders: vi.fn(async () => 0),
	wipeCustodialFiles: vi.fn(async () => 0),
}));
vi.mock("$lib/chat/server/deleteAgentServiceData", () => ({
	deleteAgentServiceData: vi.fn(async () => undefined),
	deleteAgentSessions: vi.fn(async () => undefined),
}));

import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import { wipeUserData } from "$lib/chat/server/db/wipeUserData";
import {
	listShares,
	readSharedSnapshot,
	revokeShare,
	shareConversation,
	shareForConversation,
} from "$lib/chat/server/share/sharedConversations";
import { cleanupTestData, createTestConversation, createTestUser } from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

const turn = (id: string, from: Message["from"], content: string, ancestors: string[]): Message =>
	({ id, from, content, ancestors, children: [] }) as Message;

async function sharedChat(locals: App.Locals, title: string) {
	const conv = await createTestConversation(locals, {
		title,
		rootMessageId: "u1",
		messages: [turn("u1", "user", `question for ${title}`, []), turn("a1", "assistant", `answer for ${title}`, ["u1"])],
	});
	const share = await shareConversation(locals.user!._id.toString(), conv, undefined);
	return { conv, share };
}

async function linkRows(userId: string): Promise<number> {
	return (
		await getDb()
			.select({ id: schema.sharedConversations.id })
			.from(schema.sharedConversations)
			.where(eq(schema.sharedConversations.userId, userId))
	).length;
}

afterEach(async () => {
	await cleanupTestData();
});

describe("share links", () => {
	it("shows the snapshot to anyone with the token, and a refresh keeps the same link with the new text", async () => {
		const { locals } = await createTestUser();
		const { conv, share } = await sharedChat(locals, "Glaciers");
		const first = await readSharedSnapshot(share.id);
		expect(first?.turns.map((t) => t.content)).toEqual(["question for Glaciers", "answer for Glaciers"]);

		conv.messages.push(turn("u2", "user", "and in winter?", ["u1", "a1"]));
		const refreshed = await shareConversation(locals.user!._id.toString(), conv, "u2");
		expect(refreshed.id, "a refresh minted a new link, breaking the one people were sent").toBe(share.id);
		expect((await readSharedSnapshot(share.id))?.turns.at(-1)?.content).toBe("and in winter?");
		expect(await listShares(locals.user!._id.toString())).toHaveLength(1);
	});

	it("revoke makes the link unreadable at once, and nobody else can revoke it", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const { share } = await sharedChat(owner.locals, "Owner's chat");

		expect(await revokeShare(other.locals.user!._id.toString(), share.id), "another account revoked the link").toBe(false);
		expect(await readSharedSnapshot(share.id)).not.toBeNull();

		expect(await revokeShare(owner.locals.user!._id.toString(), share.id)).toBe(true);
		expect(await readSharedSnapshot(share.id), "a revoked link still reads").toBeNull();
		expect(await shareForConversation(owner.locals.user!._id.toString(), share.conversationId)).toBeNull();
	});

	it("deleting a chat ends its link", async () => {
		const { locals } = await createTestUser();
		const { conv, share } = await sharedChat(locals, "Doomed");
		await deleteConversationsCascade([conv._id.toString()], locals.user!._id.toString());
		expect(await readSharedSnapshot(share.id), "a deleted chat is still readable through its link").toBeNull();
	});

	it("Forget everything leaves the account no live link, and leaves another account's link alone", async () => {
		const me = await createTestUser();
		const them = await createTestUser();
		const mine = await sharedChat(me.locals, "Mine one");
		const mine2 = await sharedChat(me.locals, "Mine two");
		const theirs = await sharedChat(them.locals, "Theirs");

		const summary = await wipeUserData({ userId: me.locals.user!._id.toString() });

		expect(await readSharedSnapshot(mine.share.id)).toBeNull();
		expect(await readSharedSnapshot(mine2.share.id)).toBeNull();
		expect(await linkRows(me.locals.user!._id.toString())).toBe(0);
		expect(summary.accountDeleted).toBe(false);
		expect(await readSharedSnapshot(theirs.share.id), "Forget everything took a stranger's link").not.toBeNull();
	});

	it("account delete leaves no live link either", async () => {
		const { locals } = await createTestUser();
		const { share } = await sharedChat(locals, "Gone with the account");
		await wipeUserData({ userId: locals.user!._id.toString(), deleteAccount: true });
		expect(await readSharedSnapshot(share.id)).toBeNull();
	});
});

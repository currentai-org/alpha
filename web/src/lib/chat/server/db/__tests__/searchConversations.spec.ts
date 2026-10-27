/**
 * The search dialog asks the server, which reads the caller's whole history. These run
 * against the real Postgres schema, because the match is a SQL expression over the stored document. (CUR-2630)
 */
import { describe, expect, it, afterEach } from "vitest";
import { searchConversations } from "$lib/chat/server/db/searchConversations";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

const msg = (from: "user" | "assistant", content: string) =>
	({ id: crypto.randomUUID(), from, content, children: [] }) as unknown as Message;

afterEach(cleanupTestData);

describe("searchConversations (CUR-2630)", () => {
	it("finds a chat outside the sidebar's first page of 30 by a word from its messages, with a snippet", async () => {
		const { locals } = await createTestUser();
		const old = await createTestConversation(locals, {
			title: "Trip planning",
			updatedAt: new Date("2026-01-01"),
			messages: [msg("user", "Which ferry goes to the island of Vlieland in winter?")],
		});
		for (let i = 0; i < 35; i++) {
			await createTestConversation(locals, {
				title: `Chat ${i}`,
				updatedAt: new Date(Date.UTC(2026, 5, 1, 0, i)),
				messages: [msg("user", `question ${i}`)],
			});
		}

		const hits = await searchConversations({ userId: locals.user!._id.toString() }, "VLIELAND");
		expect(hits.map((h) => h.id)).toEqual([old._id.toString()]);
		expect(hits[0].title).toBe("Trip planning");
		expect(hits[0].snippet).toContain("Vlieland");
	});

	it("never returns another owner's chat, signed in or guest, even when it matches", async () => {
		const alice = await createTestUser();
		const bob = await createTestUser();
		await createTestConversation(bob.locals, { title: "secret pancake recipe" });
		const guestLocals = { ...alice.locals, user: undefined, sessionId: "guest-session-x" };
		await createTestConversation(guestLocals, { title: "guest pancake chat" });

		expect(await searchConversations({ userId: alice.user._id.toString() }, "pancake")).toEqual([]);
		const bobHits = await searchConversations({ userId: bob.user._id.toString() }, "pancake");
		expect(bobHits.map((h) => h.title)).toEqual(["secret pancake recipe"]);
		const guestHits = await searchConversations({ sessionId: "guest-session-x" }, "pancake");
		expect(guestHits.map((h) => h.title)).toEqual(["guest pancake chat"]);
		expect(await searchConversations({ sessionId: "another-session" }, "pancake")).toEqual([]);
	});

	it("treats % and _ in a query as literal characters, not wildcards", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "growth was 5% this year" });
		await createTestConversation(locals, { title: "growth was 50 this year" });
		const owner = { userId: locals.user!._id.toString() };
		expect((await searchConversations(owner, "5%")).map((h) => h.title)).toEqual([
			"growth was 5% this year",
		]);
		expect(await searchConversations(owner, "5_")).toEqual([]);
	});

	it("returns nothing for a query under two characters or with no owner", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "a" });
		expect(await searchConversations({ userId: locals.user!._id.toString() }, "a")).toEqual([]);
		expect(await searchConversations({}, "anything")).toEqual([]);
	});
});

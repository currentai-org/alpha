/**
 * The search dialog asks the server, which reads the caller's whole history. These run
 * against the real Postgres schema, because the match is a SQL expression over the stored document.
 */
import { describe, expect, it, afterEach } from "vitest";
import { searchConversations, sealedTitleIndex } from "$lib/chat/server/db/searchConversations";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

const msg = (from: "user" | "assistant", content: string) =>
	({ id: crypto.randomUUID(), from, content, children: [] }) as unknown as Message;

afterEach(cleanupTestData);

describe("searchConversations", () => {
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

	it("returns an archived chat for a matching query, marked archived, and leaves the flag off the rest", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "harvest notes", archived: true });
		await createTestConversation(locals, { title: "harvest plan" });

		const hits = await searchConversations({ userId: locals.user!._id.toString() }, "harvest");
		const byTitle = Object.fromEntries(hits.map((h) => [h.title, h.archived]));
		expect(byTitle).toEqual({ "harvest notes": true, "harvest plan": undefined });
	});

	it("tag:grant keeps only the chats carrying that tag, alone or with words, and never another owner's", async () => {
		const { locals } = await createTestUser();
		const stranger = await createTestUser();
		const userId = locals.user!._id.toString();
		await createTestConversation(locals, { title: "budget draft", tags: ["grant"], updatedAt: new Date("2026-02-01") });
		await createTestConversation(locals, { title: "reviewer notes", tags: ["grant", "teaching_notes"], updatedAt: new Date("2026-03-01") });
		await createTestConversation(locals, { title: "budget for the trip" });
		await createTestConversation(stranger.locals, { title: "budget", tags: ["grant"] });

		const titles = async (q: string) => (await searchConversations({ userId }, q)).map((h) => h.title);
		expect(await titles("tag:grant")).toEqual(["reviewer notes", "budget draft"]);
		expect(await titles("TAG:Grant budget")).toEqual(["budget draft"]);
		expect(await titles('tag:"teaching notes"')).toEqual(["reviewer notes"]);
		expect(await titles("tag:grant tag:teaching_notes")).toEqual(["reviewer notes"]);
		expect(await titles("tag:nothing")).toEqual([]);
		// Without a tag term the words still need two characters.
		expect(await titles("b")).toEqual([]);
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

describe("sealedTitleIndex", () => {
	it("lists only the owner's sealed titles, archived ones included, still sealed, newest first", async () => {
		const { locals } = await createTestUser();
		const stranger = await createTestUser();
		const userId = locals.user!._id.toString();
		const older = await createTestConversation(locals, {
			title: "",
			sealedTitle: "c2VhbGVkLW9sZGVy",
			sealedTitleRev: 0,
			archived: true,
			updatedAt: new Date("2026-02-01"),
		});
		const newer = await createTestConversation(locals, {
			title: "",
			sealedTitle: "c2VhbGVkLW5ld2Vy",
			sealedTitleRev: 3,
			updatedAt: new Date("2026-03-01"),
		});
		await createTestConversation(locals, { title: "plain title" });
		await createTestConversation(stranger.locals, { title: "", sealedTitle: "c3RyYW5nZXI=", sealedTitleRev: 0 });

		const rows = await sealedTitleIndex({ userId });
		expect(rows.map((r) => r.id)).toEqual([newer._id.toString(), older._id.toString()]);
		expect(rows[0]).toMatchObject({ sealedTitle: "c2VhbGVkLW5ld2Vy", sealedTitleRev: 3 });
		expect(rows[0].archived).toBeUndefined();
		expect(rows[1]).toMatchObject({ sealedTitle: "c2VhbGVkLW9sZGVy", sealedTitleRev: 0, archived: true });
		expect(await sealedTitleIndex({})).toEqual([]);
	});
});

/**
 * Chat tags against real Postgres: the PATCH that sets a chat's tags, the list the sidebar's
 * filter row reads, and the sidebar's tag filter. Forget everything's half is in wipeUserData.spec.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import superjson from "superjson";
import { eq } from "drizzle-orm";
import { collections } from "$lib/chat/server/database";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { listTags } from "$lib/chat/server/db/conversationTags";
import { getLayoutConversations } from "$lib/chat/server/layoutData";
import {
	cleanupTestData,
	createTestConversation,
	createTestLocals,
	createTestUser,
} from "$lib/chat/server/api/__tests__/testHelpers";
import { PATCH } from "../../../../../routes/chat/api/v2/conversations/[id]/+server";
import { GET as getTags } from "../../../../../routes/chat/api/v2/tags/+server";
import { handleResponse } from "$lib/chat/APIClient";

afterEach(cleanupTestData);

async function patch(locals: App.Locals, id: string, body: unknown) {
	return PATCH({
		locals,
		params: { id },
		request: new Request("http://localhost", {
			method: "PATCH",
			body: JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
		}),
	} as never);
}

/** The PATCH's error status, or 200. SvelteKit's error() throws an HttpError carrying `status`. */
async function statusOf(run: Promise<Response>): Promise<number> {
	try {
		return (await run).status;
	} catch (e) {
		return (e as { status?: number }).status ?? -1;
	}
}

async function tagRows(userId: string) {
	return getDb()
		.select({ id: schema.conversationTags.id, name: schema.conversationTags.name })
		.from(schema.conversationTags)
		.where(eq(schema.conversationTags.userId, userId));
}

describe.sequential("chat tags", () => {
	it("PATCH sets a chat's tags by name, stores ids, keeps the first spelling, and answers with the stored names", async () => {
		const { locals } = await createTestUser();
		const userId = locals.user!._id.toString();
		const a = await createTestConversation(locals, { title: "first" });
		const b = await createTestConversation(locals, { title: "second" });

		const res = await patch(locals, a._id.toString(), { tags: ["Grant writing", " teaching  "] });
		expect(res.status).toBe(200);
		expect(superjson.parse(await res.text())).toMatchObject({
			success: true,
			tags: [
				{ id: "grant_writing", name: "Grant writing" },
				{ id: "teaching", name: "teaching" },
			],
		});
		expect((await collections.conversations.findOne({ _id: a._id }))?.tags).toEqual(["grant_writing", "teaching"]);

		// The same tag typed differently on another chat is the same tag, under its first spelling.
		const again = superjson.parse(await (await patch(locals, b._id.toString(), { tags: ["GRANT WRITING"] })).text());
		expect(again).toMatchObject({ tags: [{ id: "grant_writing", name: "Grant writing" }] });
		expect((await tagRows(userId)).map((t) => t.id).sort()).toEqual(["grant_writing", "teaching"]);
		// Tagging never moves a chat in the list.
		expect((await collections.conversations.findOne({ _id: a._id }))?.updatedAt).toEqual(a.updatedAt);
	});

	it("removing a tag from the last chat that used it deletes the tag; one another chat still uses stays", async () => {
		const { locals } = await createTestUser();
		const userId = locals.user!._id.toString();
		const a = await createTestConversation(locals);
		const b = await createTestConversation(locals);
		await patch(locals, a._id.toString(), { tags: ["grant", "solo"] });
		await patch(locals, b._id.toString(), { tags: ["grant"] });

		await patch(locals, a._id.toString(), { tags: [] });
		expect((await collections.conversations.findOne({ _id: a._id }))?.tags).toEqual([]);
		expect((await tagRows(userId)).map((t) => t.id)).toEqual(["grant"]);
	});

	it("refuses a guest, a malformed list, and another person's chat, and leaves the chat untagged", async () => {
		const guest = createTestLocals({ sessionId: "guest-tags" });
		const guestChat = await createTestConversation(guest);
		expect(await statusOf(patch(guest, guestChat._id.toString(), { tags: ["x"] }))).toBe(403);

		const { locals } = await createTestUser();
		const mine = await createTestConversation(locals);
		expect(await statusOf(patch(locals, mine._id.toString(), { tags: "grant" }))).toBe(400);
		expect(await statusOf(patch(locals, mine._id.toString(), { tags: [1] }))).toBe(400);

		const stranger = await createTestUser();
		const theirs = await createTestConversation(stranger.locals);
		expect(await statusOf(patch(locals, theirs._id.toString(), { tags: ["mine now"] }))).toBe(404);
		expect((await collections.conversations.findOne({ _id: theirs._id }))?.tags ?? []).toEqual([]);
		expect(await tagRows(locals.user!._id.toString())).toEqual([]);
	});

	it("the filter row lists only tags on the person's own sidebar chats, by name; the sidebar filter returns only those chats", async () => {
		const me = await createTestUser();
		const them = await createTestUser();
		const userId = me.locals.user!._id.toString();
		const one = await createTestConversation(me.locals, { title: "one", updatedAt: new Date("2026-02-01") });
		const two = await createTestConversation(me.locals, { title: "two", updatedAt: new Date("2026-03-01") });
		await createTestConversation(me.locals, { title: "untagged" });
		const put = await createTestConversation(me.locals, { title: "put away" });
		await patch(me.locals, one._id.toString(), { tags: ["teaching", "Grant"] });
		await patch(me.locals, two._id.toString(), { tags: ["grant"] });
		await patch(me.locals, put._id.toString(), { tags: ["archive only"], archived: true });
		const theirs = await createTestConversation(them.locals);
		await patch(them.locals, theirs._id.toString(), { tags: ["theirs"] });

		expect(await listTags(userId)).toEqual([
			{ id: "grant", name: "Grant" },
			{ id: "teaching", name: "teaching" },
		]);
		// The sidebar reads the route through the APIClient's handleResponse, which superjson-parses it.
		const res = await getTags({ locals: me.locals } as never);
		expect(handleResponse({ data: await res.text(), error: null, status: res.status } as never)).toEqual({
			tags: [
				{ id: "grant", name: "Grant" },
				{ id: "teaching", name: "teaching" },
			],
		});
		const { conversations } = await getLayoutConversations(me.locals, 0, null, "active", undefined, "grant");
		expect(conversations.map((c) => c.title)).toEqual(["two", "one"]);
		expect(conversations[1].tags).toEqual(["teaching", "grant"]);
	});
});

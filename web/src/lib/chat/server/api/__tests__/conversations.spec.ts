import { describe, expect, it, afterEach } from "vitest";
import superjson from "superjson";
import { collections } from "$lib/chat/server/database";
import { CONV_NUM_PER_PAGE } from "$lib/chat/constants/pagination";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "./testHelpers";

import { GET, DELETE } from "../../../../../routes/chat/api/v2/conversations/+server";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { organization } from "$lib/chat/server/db/schema";
import { getLayoutConversations } from "$lib/chat/server/layoutData";
import type { WorkspaceScope } from "$lib/chat/server/currentWorkspace";
import {
	formerWorkspaceNameOf,
	listFormerWorkspaces,
	stampDeletedWorkspace,
} from "$lib/chat/server/formerWorkspaces";

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

function mockUrl(params?: Record<string, string>): URL {
	const url = new URL("http://localhost:5173/api/v2/conversations");
	if (params) {
		for (const [key, value] of Object.entries(params)) {
			url.searchParams.set(key, value);
		}
	}
	return url;
}

describe.sequential("GET /api/v2/conversations", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("returns conversations for authenticated user", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "My Chat" });

		const res = await GET({
			locals,
			url: mockUrl(),
		} as never);

		expect(res.status).toBe(200);
		const data = await parseResponse<{
			conversations: Array<{ title: string; _id: { toString(): string } }>;
			hasMore: boolean;
		}>(res);
		expect(data.conversations).toHaveLength(1);
		expect(data.conversations[0].title).toBe("My Chat");
		expect(data.conversations[0]._id.toString()).toBe(conv._id.toString());
		expect(data.hasMore).toBe(false);
	});

	it("returns empty array for user with no conversations", async () => {
		const { locals } = await createTestUser();

		const res = await GET({
			locals,
			url: mockUrl(),
		} as never);

		expect(res.status).toBe(200);
		const data = await parseResponse<{ conversations: unknown[]; hasMore: boolean }>(res);
		expect(data.conversations).toHaveLength(0);
		expect(data.hasMore).toBe(false);
	});

	it("supports pagination with p=0 and p=1", async () => {
		const { locals } = await createTestUser();

		// Create CONV_NUM_PER_PAGE + 5 conversations with distinct updatedAt values
		for (let i = 0; i < CONV_NUM_PER_PAGE + 5; i++) {
			await createTestConversation(locals, {
				title: `Conv ${i}`,
				updatedAt: new Date(Date.now() - (CONV_NUM_PER_PAGE + 5 - i) * 1000),
			});
		}

		const resPage0 = await GET({
			locals,
			url: mockUrl({ p: "0" }),
		} as never);

		const dataPage0 = await parseResponse<{
			conversations: Array<{ title: string }>;
			hasMore: boolean;
		}>(resPage0);
		expect(dataPage0.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(dataPage0.hasMore).toBe(true);

		const resPage1 = await GET({
			locals,
			url: mockUrl({ p: "1" }),
		} as never);

		const dataPage1 = await parseResponse<{
			conversations: Array<{ title: string }>;
			hasMore: boolean;
		}>(resPage1);
		expect(dataPage1.conversations).toHaveLength(5);
		expect(dataPage1.hasMore).toBe(false);
	});

	it("returns hasMore=true when more than CONV_NUM_PER_PAGE exist", async () => {
		const { locals } = await createTestUser();

		for (let i = 0; i < CONV_NUM_PER_PAGE + 1; i++) {
			await createTestConversation(locals, {
				title: `Conv ${i}`,
				updatedAt: new Date(Date.now() - i * 1000),
			});
		}

		const res = await GET({
			locals,
			url: mockUrl(),
		} as never);

		const data = await parseResponse<{ conversations: unknown[]; hasMore: boolean }>(res);
		expect(data.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(data.hasMore).toBe(true);
	});

	it("sorts by updatedAt descending", async () => {
		const { locals } = await createTestUser();

		await createTestConversation(locals, {
			title: "Oldest",
			updatedAt: new Date("2024-01-01"),
		});
		await createTestConversation(locals, {
			title: "Newest",
			updatedAt: new Date("2024-06-01"),
		});
		await createTestConversation(locals, {
			title: "Middle",
			updatedAt: new Date("2024-03-01"),
		});

		const res = await GET({
			locals,
			url: mockUrl(),
		} as never);

		const data = await parseResponse<{ conversations: Array<{ title: string }> }>(res);
		expect(data.conversations[0].title).toBe("Newest");
		expect(data.conversations[1].title).toBe("Middle");
		expect(data.conversations[2].title).toBe("Oldest");
	});

	it("throws 401 for unauthenticated request", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });

		try {
			await GET({
				locals,
				url: mockUrl(),
			} as never);
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(401);
		}
	});

	it("does not return other users' conversations", async () => {
		const { locals: localsA } = await createTestUser();
		const { locals: localsB } = await createTestUser();

		await createTestConversation(localsA, { title: "User A Chat" });
		await createTestConversation(localsB, { title: "User B Chat" });

		const res = await GET({
			locals: localsA,
			url: mockUrl(),
		} as never);

		const data = await parseResponse<{ conversations: Array<{ title: string }> }>(res);
		expect(data.conversations).toHaveLength(1);
		expect(data.conversations[0].title).toBe("User A Chat");
	});
});

describe.sequential("DELETE /api/v2/conversations", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("removes all conversations for authenticated user", async () => {
		const { locals } = await createTestUser();

		await createTestConversation(locals, { title: "Chat 1" });
		await createTestConversation(locals, { title: "Chat 2" });
		await createTestConversation(locals, { title: "Chat 3" });

		const res = await DELETE({ locals, url: mockUrl() } as never);
		expect(res.status).toBe(200);

		// DELETE now returns a WipeSummary (GDPR Art.17 wipe), not a bare deleted-count.
		const data = await parseResponse<{ conversations: number }>(res);
		expect(data.conversations).toBe(3);

		const remaining = await collections.conversations.countDocuments();
		expect(remaining).toBe(0);
	});

	it("throws 401 for unauthenticated request", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });

		try {
			await DELETE({ locals, url: mockUrl() } as never);
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(401);
		}
	});

	it("does not remove other users' conversations", async () => {
		const { locals: localsA } = await createTestUser();
		const { locals: localsB } = await createTestUser();

		await createTestConversation(localsA, { title: "User A Chat" });
		await createTestConversation(localsB, { title: "User B Chat" });

		const res = await DELETE({ locals: localsA, url: mockUrl() } as never);
		const data = await parseResponse<{ conversations: number }>(res);
		expect(data.conversations).toBe(1);

		const remaining = await collections.conversations.countDocuments();
		expect(remaining).toBe(1);

		const userBConvs = await collections.conversations
			.find({ userId: localsB.user?._id })
			.toArray();
		expect(userBConvs).toHaveLength(1);
		expect(userBConvs[0].title).toBe("User B Chat");
	});
});

// Each workspace keeps its own conversations. CUR-3040: chats from a workspace the person
// left, or that was deleted, list under that former workspace and no longer in Personal. The
// membership read that builds the scope in production is covered by the workspaces e2e scenarios;
// the former-workspace reads below run against the real tables. (CUR-3023)
describe.sequential("getLayoutConversations scoped by workspace", () => {
	const TEAM = "cur3023-team";
	const LEFT = "cur3023-left";
	const GONE = "cur3040-gone";

	afterEach(async () => {
		await cleanupTestData();
		await getDb().delete(organization).where(inArray(organization.id, [TEAM, LEFT, GONE]));
	});

	async function seed() {
		await getDb()
			.insert(organization)
			.values(
				[TEAM, LEFT, GONE].map((id) => ({ id, name: `${id} name`, slug: id, createdAt: new Date() }))
			)
			.onConflictDoNothing();
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "personal" });
		await createTestConversation(locals, { title: "team", organizationId: TEAM });
		await createTestConversation(locals, { title: "left behind", organizationId: LEFT });
		await createTestConversation(locals, { title: "deleted team's", organizationId: GONE });
		// What Better Auth's beforeDeleteOrganization hook does, then the delete itself.
		await stampDeletedWorkspace(GONE, `${GONE} name`);
		await getDb().delete(organization).where(eq(organization.id, GONE));
		return locals;
	}

	async function scopeFor(
		locals: App.Locals,
		current: { id: string; name: string } | null,
		viewing?: string
	): Promise<NonNullable<WorkspaceScope>> {
		const memberOrgIds = [TEAM];
		const former = await listFormerWorkspaces(String(locals.user?._id), memberOrgIds);
		return {
			current,
			memberOrgIds,
			workspaces: [{ id: TEAM, name: TEAM }],
			former,
			viewingFormer: former.find((w) => w.id === viewing) ?? null,
			invitations: [],
		};
	}

	const titles = async (locals: App.Locals, scope: WorkspaceScope) =>
		(await getLayoutConversations(locals, 0, scope)).conversations.map((c) => c.title).sort();

	it("a team workspace lists only the conversations started in it", async () => {
		const locals = await seed();
		expect(await titles(locals, await scopeFor(locals, { id: TEAM, name: TEAM }))).toEqual(["team"]);
	});

	it("finds both former workspaces, sorted by name: one the person left, one deleted under them", async () => {
		const locals = await seed();
		expect((await scopeFor(locals, null)).former).toEqual([
			{ id: LEFT, name: `${LEFT} name`, kind: "left" },
			{ id: GONE, name: `${GONE} name`, kind: "deleted" },
		]);
	});

	it("Personal lists only chats from no workspace, not a left or deleted workspace's", async () => {
		const locals = await seed();
		expect(await titles(locals, await scopeFor(locals, null))).toEqual(["personal"]);
	});

	it("a left workspace lists its own chats under its former entry", async () => {
		const locals = await seed();
		expect(await titles(locals, await scopeFor(locals, null, LEFT))).toEqual(["left behind"]);
	});

	it("a deleted workspace lists its own chats under its former entry, though the delete nulled their organization_id", async () => {
		const locals = await seed();
		expect(await titles(locals, await scopeFor(locals, null, GONE))).toEqual(["deleted team's"]);
	});

	it("a deleted workspace's chat names it and is read-only; a current workspace's chat is neither", async () => {
		const locals = await seed();
		const scope = await scopeFor(locals, null);
		const convs = await collections.conversations.find({ userId: locals.user?._id }).toArray();
		const named = Object.fromEntries(convs.map((c) => [c.title, formerWorkspaceNameOf(c, scope)]));
		expect(named).toEqual({
			personal: null,
			team: null,
			"left behind": `${LEFT} name`,
			"deleted team's": `${GONE} name`,
		});
	});

	it("lists every conversation, unscoped, when there is no scope (flag off, guest, or a failed read)", async () => {
		const locals = await seed();
		expect(await titles(locals, null)).toEqual([
			"deleted team's",
			"left behind",
			"personal",
			"team",
		]);
	});
});

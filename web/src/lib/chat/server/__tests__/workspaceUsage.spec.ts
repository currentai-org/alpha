/**
 * "counts only... structurally enforced, not just a UI choice." Test 4 below is the actual
 * point of this file — it plants a distinctive, sensitive-looking string in a real conversation's
 * title AND message content, then asserts it is not anywhere in getWorkspaceUsage's return value. A
 * mock of getDb() couldn't prove that; only a real query against a real row can.
 *
 * Also covers the id-space trap the module's own header documents: getWorkspaceUsage takes Better
 * Auth ids, conversations.userId stores the SHADOW id (auth.ts's shadowUserId) — these tests seed
 * conversations keyed by the shadow id computed from each test's own Better-Auth-shaped id, exactly
 * as the real bridge in auth.ts would, rather than assuming the two are interchangeable. (CUR-552)
 */
import { describe, expect, it, afterEach } from "vitest";
import { ObjectId } from "bson";
import { eq } from "drizzle-orm";
import { getWorkspaceUsage } from "$lib/chat/server/workspaceUsage";
import { shadowUserId } from "$lib/chat/server/auth";
import { getDb } from "$lib/chat/server/db/client";
import { organization, ragDocuments } from "$lib/chat/server/db/schema";
import {
	createTestLocals,
	createTestConversation,
	cleanupTestData,
} from "$lib/chat/server/api/__tests__/testHelpers";
import type { Message } from "$lib/chat/types/Message";

function msg(content: string): Message {
	return { from: "user", id: crypto.randomUUID(), content };
}

async function localsForBetterAuthUser(betterAuthUserId: string) {
	const shadowId = await shadowUserId(betterAuthUserId);
	return createTestLocals({ user: { _id: new ObjectId(shadowId) } as never });
}

// conversations.organizationId is a real FK now, so any test that stamps one on a test
// conversation needs a row in `organization` to point at — a bare string id 404s the insert. (CUR-961)
async function withTestOrgs<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
	const db = getDb();
	const now = new Date();
	await db.insert(organization).values(ids.map((id) => ({ id, name: id, slug: id, createdAt: now })));
	try {
		return await fn();
	} finally {
		for (const id of ids) await db.delete(organization).where(eq(organization.id, id));
	}
}

describe.sequential("getWorkspaceUsage (CUR-552)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("returns empty usage for an empty member list without querying", async () => {
		expect(await getWorkspaceUsage([])).toEqual({
			totalConversations: 0,
			totalMessages: 0,
			activeMemberCount: 0,
			perMember: [],
			documentCount: 0,
		});
	});

	it("aggregates conversation and message counts per member, and workspace-wide", async () => {
		const orgId = `org-${crypto.randomUUID()}`;
		await withTestOrgs([orgId], async () => {
			const activeMember = "ba-active-member";
			const idleMember = "ba-idle-member";
			const noConvoMember = "ba-no-convo-member";

			const activeLocals = await localsForBetterAuthUser(activeMember);
			await createTestConversation(activeLocals, {
				organizationId: orgId,
				messages: [msg("a"), msg("b"), msg("c")],
				updatedAt: new Date(), // recent -> counts as active
			});

			const idleLocals = await localsForBetterAuthUser(idleMember);
			await createTestConversation(idleLocals, {
				organizationId: orgId,
				messages: [msg("a")],
				updatedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000), // 60 days ago -> not active
			});

			const usage = await getWorkspaceUsage([activeMember, idleMember, noConvoMember], orgId);

			expect(usage.totalConversations).toBe(2);
			expect(usage.totalMessages).toBe(4);
			expect(usage.activeMemberCount).toBe(1);

			const byId = new Map(usage.perMember.map((m) => [m.userId, m]));
			// A real Date instance, not the raw Postgres timestamp string a `max(...)` aggregate returns
			// undecorated — activeMemberCount depends on a Date, and a string would silently read 0.
			expect(byId.get(activeMember)?.lastActiveAt).toBeInstanceOf(Date);
			expect(byId.get(activeMember)).toMatchObject({ conversationCount: 1, messageCount: 3 });
			expect(byId.get(idleMember)).toMatchObject({ conversationCount: 1, messageCount: 1 });
			expect(byId.get(noConvoMember)).toMatchObject({
				conversationCount: 0,
				messageCount: 0,
				lastActiveAt: null,
			});
		});
	});

	it("never includes a NON-member's conversations, even one created in the same run", async () => {
		const orgId = `org-${crypto.randomUUID()}`;
		await withTestOrgs([orgId], async () => {
			const member = "ba-in-workspace";
			const outsider = "ba-not-in-workspace";

			await createTestConversation(await localsForBetterAuthUser(member), {
				organizationId: orgId,
				messages: [msg("member's message")],
			});
			await createTestConversation(await localsForBetterAuthUser(outsider), {
				organizationId: orgId,
				messages: [msg("outsider's message"), msg("another one")],
			});

			const usage = await getWorkspaceUsage([member], orgId);
			expect(usage.totalConversations).toBe(1);
			expect(usage.totalMessages).toBe(1);
		});
	});

	it("the return value never contains conversation content, structurally — not by omission", async () => {
		const orgId = `org-${crypto.randomUUID()}`;
		await withTestOrgs([orgId], async () => {
			const member = "ba-content-test-member";
			const secret = "SSN-123-45-6789-do-not-leak-this-string";
			await createTestConversation(await localsForBetterAuthUser(member), {
				organizationId: orgId,
				title: secret,
				messages: [msg(secret)],
			});

			const usage = await getWorkspaceUsage([member], orgId);
			expect(JSON.stringify(usage)).not.toContain(secret);
			// The count is still real work, not a coincidentally-empty result hiding a broken query.
			expect(usage.totalMessages).toBe(1);
		});
	});

	it("CUR-961: a workspace with no attributed activity reads zero, even for an admin with a long personal history elsewhere", async () => {
		const orgId = `org-${crypto.randomUUID()}`;
		const admin = "ba-usage-admin";

		// The exact repro: the admin has real Alpha usage, none of it attributed to this workspace.
		await createTestConversation(await localsForBetterAuthUser(admin), {
			messages: [msg("a"), msg("b"), msg("c")],
			// no organizationId — this conversation happened outside any workspace
		});

		const usage = await getWorkspaceUsage([admin], orgId);
		expect(usage).toMatchObject({ totalConversations: 0, totalMessages: 0, activeMemberCount: 0 });
		expect(usage.perMember).toEqual([
			{ userId: admin, conversationCount: 0, messageCount: 0, lastActiveAt: null },
		]);
	});

	it("CUR-961: two workspaces belonging to the same person show different numbers when their activity differs", async () => {
		const orgWithActivity = `org-${crypto.randomUUID()}`;
		const orgWithoutActivity = `org-${crypto.randomUUID()}`;
		await withTestOrgs([orgWithActivity, orgWithoutActivity], async () => {
			const person = "ba-multi-workspace-person";

			await createTestConversation(await localsForBetterAuthUser(person), {
				organizationId: orgWithActivity,
				messages: [msg("a"), msg("b")],
			});

			expect((await getWorkspaceUsage([person], orgWithActivity)).totalConversations).toBe(1);
			expect((await getWorkspaceUsage([person], orgWithoutActivity)).totalConversations).toBe(0);
		});
	});

	it("CUR-736/CUR-827: documentCount counts only THIS workspace's own rag_documents, by organizationId", async () => {
		const db = getDb();
		const orgId = `org-${crypto.randomUUID()}`;
		const otherOrgId = `org-${crypto.randomUUID()}`;
		const now = new Date();
		await db.insert(organization).values([
			{ id: orgId, name: "Org A", slug: `org-a-${orgId}`, createdAt: now },
			{ id: otherOrgId, name: "Org B", slug: `org-b-${otherOrgId}`, createdAt: now },
		]);
		try {
			await db.insert(ragDocuments).values([
				{ id: crypto.randomUUID(), title: "in this workspace", source: "test", organizationId: orgId },
				{ id: crypto.randomUUID(), title: "a different workspace", source: "test", organizationId: otherOrgId },
				{ id: crypto.randomUUID(), title: "site-wide corpus, no workspace at all", source: "test" },
			]);

			expect((await getWorkspaceUsage([], orgId)).documentCount).toBe(1);
			expect((await getWorkspaceUsage([], otherOrgId)).documentCount).toBe(1);
			// Omitting organizationId entirely must stay 0, not "every document" — the whole point of the
			// column is that a caller who forgets to scope gets nothing, never everyone else's documents.
			expect((await getWorkspaceUsage([])).documentCount).toBe(0);
		} finally {
			// Cascades rag_documents (onDelete:"cascade") for free — same mechanism CUR-827's admin
			// delete relies on in production, exercised here as cleanup rather than product behavior.
			await db.delete(organization).where(eq(organization.id, orgId));
			await db.delete(organization).where(eq(organization.id, otherOrgId));
		}
	});
});

// An admin can see who is active and how much the workspace is used: counts only, never the content
// of a member's conversations (CUR-552). That is enforced HERE, structurally, not left to the caller
// to omit fields: every query in this file
// selects only aggregate scalars (count, sum, max) and never the `doc` column itself, so there is no
// code path through which a title, a preview, or message text could reach the return value. A
// conversation title is usually a model-generated summary of the first message — content wearing a
// metadata costume — which is exactly why this file has no function that returns anything
// per-conversation, only per-member and workspace-wide aggregates.
//
// The id-space trap this file exists to get right: workspace membership (member.userId) is keyed by
// Better Auth's own user id, but conversations.userId is keyed by the SHADOW doc-store user id — a
// hash of that same id (auth.ts's shadowUserId, CUR-434). A query joining the two directly would
// silently match zero rows for every workspace, not error.
//
// Membership alone isn't workspace scope (CUR-961). A member's conversations.organizationId column
// (schema.ts) records which workspace was active when a conversation was created — the counting
// query below requires BOTH a membership match and an organizationId match; membership alone would
// let a brand-new empty workspace show an admin's lifetime usage from everywhere else.

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { conversations, ragDocuments } from "$lib/chat/server/db/schema";
import { shadowUserId } from "$lib/chat/server/auth";

const ACTIVE_WINDOW_DAYS = 30;

export type MemberUsage = {
	/** Better Auth user id — the same id member.userId and getFullOrganization's members[].userId use. */
	userId: string;
	conversationCount: number;
	messageCount: number;
	lastActiveAt: Date | null;
};

export type WorkspaceUsage = {
	totalConversations: number;
	totalMessages: number;
	/** Members with a conversation update inside the last ACTIVE_WINDOW_DAYS. */
	activeMemberCount: number;
	perMember: MemberUsage[];
	/** rag_documents rows scoped to this workspace (organizationId), for the delete
	 *  confirmation's "naming what goes" disclosure — a count, same posture as everything else in this (CUR-736/CUR-827)
	 *  file, no titles or content. 0 when organizationId is omitted, not "unknown". */
	documentCount: number;
};

const EMPTY_USAGE: WorkspaceUsage = {
	totalConversations: 0,
	totalMessages: 0,
	activeMemberCount: 0,
	perMember: [],
	documentCount: 0,
};

/**
 * Aggregate, counts-only usage for a set of workspace members (pass member.userId values — Better
 * Auth ids, not shadow ids; the id-space conversion happens inside). `organizationId` is optional and
 * used only for the document count — documents are scoped directly by organizationId, unlike
 * conversations, which have none (CUR-736's decision).
 */
export async function getWorkspaceUsage(
	memberUserIds: string[],
	organizationId?: string
): Promise<WorkspaceUsage> {
	const documentCount = organizationId ? await countWorkspaceDocuments(organizationId) : 0;
	// No workspace, no conversation usage — same posture as documentCount just above. The conversation
	// query below filters on organizationId; without that filter it would return a member's usage across
	// every workspace, not usage inside this one (CUR-961).
	if (memberUserIds.length === 0 || !organizationId) return { ...EMPTY_USAGE, documentCount };

	const shadowIds = await Promise.all(memberUserIds.map(shadowUserId));
	const shadowToReal = new Map(shadowIds.map((shadow, i) => [shadow, memberUserIds[i]]));

	const rows = await getDb()
		.select({
			shadowUserId: conversations.userId,
			conversationCount: sql<number>`count(*)::int`,
			// coalesce guards a legacy/malformed doc with no messages array — jsonb_array_length errors
			// on a non-array input rather than returning 0, and this is an aggregate over every row for
			// the member, not a single lookup that could 404 instead.
			messageCount: sql<number>`coalesce(sum(jsonb_array_length(coalesce(${conversations.doc}->'messages', '[]'::jsonb))), 0)::int`,
			// Comes back as a Postgres-formatted STRING here, not an auto-parsed Date:
			// postgres.js's date parser applies to a plain column reference's own type OID, not to a raw
			// `max(...)` aggregate expression's result. Typed honestly (string, not Date) so the actual
			// `new Date(...)` conversion below isn't skipped by a type annotation that just asserts it away.
			lastActiveAt: sql<string | null>`max(${conversations.updatedAt})`,
		})
		.from(conversations)
		// Two-factor scope, both required: attributed to THIS workspace (organizationId) AND a
		// CURRENT member (shadowIds) — a departed member's workspace-attributed history drops out of
		// the total along with them, same as it always has for someone outside memberUserIds.
		.where(and(eq(conversations.organizationId, organizationId), inArray(conversations.userId, shadowIds)))
		.groupBy(conversations.userId);

	const activeCutoff = new Date(Date.now() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
	const byRealUserId = new Map(
		rows
			.filter((r) => r.shadowUserId !== null && shadowToReal.has(r.shadowUserId))
			.map((r) => [shadowToReal.get(r.shadowUserId as string) as string, r])
	);

	const perMember: MemberUsage[] = memberUserIds.map((userId) => {
		const row = byRealUserId.get(userId);
		return {
			userId,
			conversationCount: row?.conversationCount ?? 0,
			messageCount: row?.messageCount ?? 0,
			lastActiveAt: row?.lastActiveAt ? new Date(row.lastActiveAt) : null,
		};
	});

	return {
		totalConversations: perMember.reduce((sum, m) => sum + m.conversationCount, 0),
		totalMessages: perMember.reduce((sum, m) => sum + m.messageCount, 0),
		activeMemberCount: perMember.filter((m) => m.lastActiveAt && m.lastActiveAt >= activeCutoff)
			.length,
		perMember,
		documentCount,
	};
}

async function countWorkspaceDocuments(organizationId: string): Promise<number> {
	const [row] = await getDb()
		.select({ count: sql<number>`count(*)::int` })
		.from(ragDocuments)
		.where(eq(ragDocuments.organizationId, organizationId));
	return row?.count ?? 0;
}

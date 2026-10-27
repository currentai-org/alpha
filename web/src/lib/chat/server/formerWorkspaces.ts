// A person removed from a team, or whose team workspace was deleted, keeps that team's old chats
// (a conversation is never workspace property, CUR-736). They sit together under one
// "Former: <name>" entry, read-only (CUR-3040).
//
// A left workspace still has its organization row, so its chats keep organization_id and its name
// comes from a join. A deleted workspace takes its row with it and the foreign key nulls
// organization_id (db/schema.ts, onDelete "set null"), so before the delete its chats are stamped
// with the id and name in `doc`. Chats from workspaces deleted before this shipped carry no stamp
// and stay in Personal: the name was never kept.
import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { conversations, organization } from "$lib/chat/server/db/schema";

export type FormerWorkspace = { id: string; name: string; kind: "left" | "deleted" };

/** The cookie holding which former workspace a person is looking at. It counts only while the
 *  session has no team workspace active, and the workspace page clears it on any switch. */
export const FORMER_WORKSPACE_COOKIE = "alpha-former-workspace";

/** Stamps a workspace's conversations with its id and name while its row still exists. The doc's own
 *  organizationId goes at the same time: the column is rebuilt from the doc on every write, and a
 *  deleted workspace's id there would fail the foreign key. */
export async function stampDeletedWorkspace(organizationId: string, name: string): Promise<number> {
	const stamp = JSON.stringify({ formerWorkspaceId: organizationId, formerWorkspaceName: name });
	const rows = await getDb()
		.update(conversations)
		.set({ doc: sql`(${conversations.doc} - 'organizationId') || ${stamp}::jsonb` })
		.where(eq(conversations.organizationId, organizationId))
		.returning({ id: conversations.id });
	return rows.length;
}

/** Every workspace a signed-in person has chats from but no longer belongs to, by name. `userId` is
 *  the shadow `users.id` that conversations carry (auth.ts), which differs from Better Auth's id. */
export async function listFormerWorkspaces(
	userId: string,
	memberOrgIds: string[]
): Promise<FormerWorkspace[]> {
	const db = getDb();
	const [left, deleted] = await Promise.all([
		db
			.selectDistinct({ id: organization.id, name: organization.name, kind: sql<"left">`'left'` })
			.from(conversations)
			.innerJoin(organization, eq(conversations.organizationId, organization.id))
			.where(
				and(
					eq(conversations.userId, userId),
					isNotNull(conversations.organizationId),
					memberOrgIds.length ? notInArray(conversations.organizationId, memberOrgIds) : undefined
				)
			),
		db
			.selectDistinct({
				id: sql<string>`${conversations.doc}->>'formerWorkspaceId'`,
				name: sql<string>`${conversations.doc}->>'formerWorkspaceName'`,
				kind: sql<"deleted">`'deleted'`,
			})
			.from(conversations)
			.where(and(eq(conversations.userId, userId), sql`${conversations.doc} ? 'formerWorkspaceId'`)),
	]);
	const byId = new Map<string, FormerWorkspace>();
	for (const w of [...left, ...deleted]) if (w.id && !byId.has(w.id)) byId.set(w.id, w);
	return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The name of the former workspace a conversation belongs to, or null when it is Personal or in a
 *  workspace the person still belongs to. Such a chat is read-only: nobody is in that workspace on
 *  this person's behalf any more. */
export function formerWorkspaceNameOf(
	conv: { organizationId?: string | null; formerWorkspaceId?: string; formerWorkspaceName?: string },
	scope: { memberOrgIds: string[]; former: FormerWorkspace[] }
): string | null {
	if (conv.formerWorkspaceId) return conv.formerWorkspaceName ?? "a deleted workspace";
	if (!conv.organizationId || scope.memberOrgIds.includes(conv.organizationId)) return null;
	return scope.former.find((w) => w.id === conv.organizationId)?.name ?? "a former workspace";
}

/** True when a conversation carries any workspace mark, so only those pay for the scope read. */
export function hasWorkspaceMark(conv: { organizationId?: string | null; formerWorkspaceId?: string }) {
	return Boolean(conv.organizationId || conv.formerWorkspaceId);
}

/** The list filter for one former workspace's chats. A left one's chats still carry its id in the
 *  column; a deleted one's carry it only in the stamp. */
export function formerWorkspaceFilter(w: FormerWorkspace): Record<string, unknown> {
	return w.kind === "left" ? { organizationId: w.id } : { formerWorkspaceId: w.id };
}

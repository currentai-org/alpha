// "I can belong to several workspaces and always know which one I'm in." The switch lives on
// Settings → Workspace, but the chat itself never said which workspace was current, so the account
// menu reads it from here.
//
// The session's activeOrganizationId alone can name a workspace the person has since left or that
// was deleted under them, so the name is read through their own membership row: no row,
// no workspace shown.
// The same read scopes the conversation list. Each workspace lists its own conversations.
// Chats from a workspace the person left, or that was deleted, list under that former
// workspace (formerWorkspaces.ts); Personal lists the rest.
import { and, eq } from "drizzle-orm";
import { getAuth } from "$lib/chat/server/betterAuth";
import { getDb } from "$lib/chat/server/db/client";
import { member, organization } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";
import { workspaceOrgCreationEnabled } from "$lib/chat/server/workspacesGate";
import { pendingInvitationsFor, type PendingInvitation } from "$lib/chat/server/pendingInvitations";
import {
	FORMER_WORKSPACE_COOKIE,
	listFormerWorkspaces,
	type FormerWorkspace,
} from "$lib/chat/server/formerWorkspaces";

type CurrentWorkspace = { id: string; name: string } | null;

/** Which workspace is current and which ones the person belongs to. Null means "don't scope": the
 *  workspaces flag is off, the visitor is a guest, there is no request, or the read failed. */
export type WorkspaceScope = {
	current: CurrentWorkspace;
	memberOrgIds: string[];
	/** Every workspace the person belongs to, for the account menu's switcher. */
	workspaces: { id: string; name: string }[];
	/** Workspaces the person has chats from but no longer belongs to. */
	former: FormerWorkspace[];
	/** The former workspace being looked at, only while no team workspace is current. */
	viewingFormer: FormerWorkspace | null;
	/** Invitations waiting on this person, for the account menu and Settings. */
	invitations: PendingInvitation[];
} | null;

export async function workspaceScopeFor(
	locals: App.Locals,
	headers: Headers | undefined
): Promise<WorkspaceScope> {
	if (!locals.user || !headers) return null;
	const started = Date.now();
	try {
		const session = await getAuth().api.getSession({ headers });
		if (!session) return null;
		const rows = await getDb()
			.select({ id: organization.id, name: organization.name })
			.from(member)
			.innerJoin(organization, eq(member.organizationId, organization.id))
			.where(eq(member.userId, session.user.id));
		const activeId = session.session.activeOrganizationId;
		const current = rows.find((r) => r.id === activeId) ?? null;
		const memberOrgIds = rows.map((r) => r.id);
		// Accepting lives behind the org-creation flag (the accept page 404s without it), so the list does too.
		const [former, invitations] = await Promise.all([
			listFormerWorkspaces(String(locals.user._id), memberOrgIds),
			workspaceOrgCreationEnabled() ? pendingInvitationsFor(session.user) : Promise.resolve([]),
		]);
		const picked = cookieValue(headers, FORMER_WORKSPACE_COOKIE);
		return {
			current,
			memberOrgIds,
			workspaces: rows,
			former,
			viewingFormer: current ? null : (former.find((w) => w.id === picked) ?? null),
			invitations,
		};
	} catch (err) {
		// A failed read leaves the label off and the list unscoped: every row in it is still the
		// person's own, so the cost is a mixed list, never someone else's conversation.
		logger.warn({ err, ms: Date.now() - started }, "[currentWorkspace] read failed; showing none");
		return null;
	}
}

/** The workspace id a new row should be attributed to: the session's active workspace, but only
 *  while the person still has a membership in an organization that exists. A pointer at a deleted or
 *  left workspace gives undefined (Personal), because writing it fails the organization foreign key
 *  and the request with it. */
export async function activeWorkspaceIdFor(
	locals: App.Locals,
	headers: Headers
): Promise<string | undefined> {
	if (!locals.user) return undefined;
	const session = await getAuth().api.getSession({ headers });
	const activeId = session?.session.activeOrganizationId;
	if (!session || !activeId) return undefined;
	const rows = await getDb()
		.select({ id: organization.id })
		.from(member)
		.innerJoin(organization, eq(member.organizationId, organization.id))
		.where(and(eq(member.userId, session.user.id), eq(member.organizationId, activeId)));
	return rows[0]?.id;
}

function cookieValue(headers: Headers, name: string): string | undefined {
	for (const part of headers.get("cookie")?.split(";") ?? []) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return decodeURIComponent(rest.join("="));
	}
	return undefined;
}

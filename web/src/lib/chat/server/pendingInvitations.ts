// A person invited to a workspace while signed in has the invite only as a link in the
// email (CUR-550), so the account menu and Settings → Workspace now
// list each pending invite to the signed-in address and link it to the same accept page.
//
// One query rather than the organization plugin's `listUserInvitations`: that endpoint returns expired
// rows and no inviter, so it would take this query's join anyway. Its two rules are kept here: nothing
// is listed to an unverified address, and only rows for the session's own address come back.
//
// Any account can put a workspace name it chose in front of any address, so the list is also a way
// into someone's attention that sends no mail. The name renders as plain text (PendingInviteRow), and
// the per-address cap on pending invites is enforced where invites are created (refuseOverInviteCaps). (CUR-4167)
import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { invitation, organization, user } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";

export type PendingInvitation = { id: string; workspaceName: string; inviterEmail: string };

type SessionUser = { email: string; emailVerified: boolean };
type InvitationRow = PendingInvitation & { email: string; status: string; expiresAt: Date };

/** The rows to show this person: only to a verified address, only their own, only pending and live. */
function visibleInvitations(who: SessionUser, rows: InvitationRow[], now: Date): PendingInvitation[] {
	if (!who.emailVerified) return [];
	const email = who.email.trim().toLowerCase();
	return rows
		.filter((r) => r.email.trim().toLowerCase() === email && r.status === "pending" && r.expiresAt > now)
		.map(({ id, workspaceName, inviterEmail }) => ({ id, workspaceName, inviterEmail }));
}

/** Pending invitations to the signed-in person's address. Empty on an unverified address or a failed read. */
export async function pendingInvitationsFor(who: SessionUser): Promise<PendingInvitation[]> {
	if (!who.emailVerified) return [];
	const started = Date.now();
	const now = new Date();
	try {
		const rows = await getDb()
			.select({
				id: invitation.id,
				email: invitation.email,
				status: invitation.status,
				expiresAt: invitation.expiresAt,
				workspaceName: organization.name,
				inviterEmail: user.email,
			})
			.from(invitation)
			.innerJoin(organization, eq(invitation.organizationId, organization.id))
			.innerJoin(user, eq(invitation.inviterId, user.id))
			.where(
				and(
					eq(sql`lower(${invitation.email})`, who.email.trim().toLowerCase()),
					eq(invitation.status, "pending"),
					gt(invitation.expiresAt, now)
				)
			);
		return visibleInvitations(who, rows, now);
	} catch (err) {
		logger.warn({ err, ms: Date.now() - started }, "[pendingInvitations] read failed; listing none");
		return [];
	}
}

/** How many live pending invitations an address holds, for the per-address cap. Null when the read fails. */
export async function pendingInvitationCount(email: string): Promise<number | null> {
	try {
		const [row] = await getDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(invitation)
			.where(
				and(
					eq(sql`lower(${invitation.email})`, email.trim().toLowerCase()),
					eq(invitation.status, "pending"),
					gt(invitation.expiresAt, new Date())
				)
			);
		return row?.n ?? 0;
	} catch (err) {
		logger.warn({ err }, "[pendingInvitations] count failed; not capping");
		return null;
	}
}

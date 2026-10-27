// A new session starts in the workspace the person last chose (CUR-3024). Better Auth keeps the
// active workspace on the session row, and sign-out deletes that row, so without this every sign-in
// would start in Personal. The choice is copied onto the user whenever a session's active workspace
// is written, and read back when a session is created.
//
// The return is automatic and unasked, a product decision; CUR-3038 explores asking at sign-in
// instead. It never returns anyone to a workspace they no longer belong to: the membership
// row is checked, so a deleted workspace or a removal lands in Personal (CUR-3022).
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { member, user } from "$lib/chat/server/db/schema";
import { logger } from "$lib/chat/server/logger";
import { workspacesEnabled } from "$lib/chat/server/workspacesGate";

/** Records the workspace a session now has active (null is Personal) as the person's last choice.
 *  A session refresh rewrites the same value, so the write only lands when it differs. */
export async function rememberActiveWorkspace(
	userId: string,
	organizationId: string | null | undefined
): Promise<void> {
	if (!workspacesEnabled()) return;
	const next = organizationId ?? null;
	const started = Date.now();
	try {
		await getDb()
			.update(user)
			.set({ lastActiveOrganizationId: next })
			.where(and(eq(user.id, userId), sql`${user.lastActiveOrganizationId} IS DISTINCT FROM ${next}`));
	} catch (err) {
		// Losing the record costs one sign-in in Personal, never a failed request.
		logger.warn({ err, ms: Date.now() - started }, "[resumeWorkspace] could not record the active workspace");
	}
}

/** The workspace a new session should start in: the last one chosen, while the person is still a
 *  member of it. Null (Personal) otherwise, and on any failure, so a sign-in never fails over it. */
export async function workspaceToResume(userId: string): Promise<string | null> {
	if (!workspacesEnabled()) return null;
	const started = Date.now();
	try {
		const [row] = await getDb()
			.select({ organizationId: member.organizationId })
			.from(user)
			.innerJoin(
				member,
				and(eq(member.userId, user.id), eq(member.organizationId, user.lastActiveOrganizationId))
			)
			.where(eq(user.id, userId))
			.limit(1);
		return row?.organizationId ?? null;
	} catch (err) {
		logger.warn({ err, ms: Date.now() - started }, "[resumeWorkspace] could not read the last workspace; starting in Personal");
		return null;
	}
}

// "admin or uploader may delete" (CUR-736's first organisation data rule) — the
// permission check a workspace-scoped document read/write should assert. No route calls this today:
// the only existing rag_documents writer is the site-admin RAG console (adminWrites.ts, gated by
// requireAdminAccess — a different actor namespace entirely, always allowed regardless of this check,
// since it manages the site-wide corpus, not a workspace's own documents). This exists for CUR-545
// (member-facing document upload, not yet built) or any future workspace-document route to call at its
// own boundary — same CUR-412 discipline: check ownership where the read/write happens, not assumed
// from how a row was queried.
//
// Id-space trap, the same one workspaceUsage.ts already documents: rag_documents.createdBy is keyed by
// the DOC-STORE shadow user id (auth.ts's shadowUserId), not Better Auth's own user.id — the id a
// workspace-scoped caller (member.userId, session.user.id) actually holds. Bridged here so a caller
// can't get this wrong the way a direct `createdBy === session.user.id` comparison would (always false). (CUR-736/CUR-827)

import { shadowUserId } from "$lib/chat/server/auth";

export class RagDocumentOwnershipError extends Error {
	constructor(userId: string, documentId: string) {
		super(`user ${userId} may not modify rag document ${documentId} (not the workspace admin or uploader)`);
		this.name = "RagDocumentOwnershipError";
	}
}

export interface RagDocumentAccessCheck {
	/** Better Auth user id — the id a workspace-scoped caller actually holds. */
	actorUserId: string;
	/** Whether the actor holds the "admin" role in the document's own workspace. */
	actorIsWorkspaceAdmin: boolean;
	documentId: string;
	/** The document's own `createdBy` column value (doc-store shadow id), or null if unset. */
	createdBy: string | null;
	/** The workspace the actor is currently acting within. */
	actorOrganizationId: string;
	/** The workspace the document itself belongs to. */
	documentOrganizationId: string;
}

/**
 * Throws RagDocumentOwnershipError unless the actor is acting within the document's own workspace AND
 * is that workspace's admin OR the person who uploaded it (CUR-736). Throws rather
 * than returning a boolean, same assert-or-throw shape as custodialBucket.ts's assertOwnership, so a
 * caller can't forget to check.
 *
 * The workspace comparison binds the caller-computed `actorIsWorkspaceAdmin` to the workspace the
 * document actually belongs to; without it an admin of workspace A passing workspace B's documentId
 * would pass (CUR-929). Checked FIRST, before either the admin or uploader branch — a workspace
 * mismatch is disqualifying regardless of role, not just an extra condition on the admin path.
 */
export async function assertRagDocumentAccess(check: RagDocumentAccessCheck): Promise<void> {
	if (check.actorOrganizationId !== check.documentOrganizationId) {
		throw new RagDocumentOwnershipError(check.actorUserId, check.documentId);
	}
	if (check.actorIsWorkspaceAdmin) return;
	if (check.createdBy && (await shadowUserId(check.actorUserId)) === check.createdBy) return;
	throw new RagDocumentOwnershipError(check.actorUserId, check.documentId);
}

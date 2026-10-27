// "admin or uploader may delete" — the escape/edge cases are the point, same
// discipline as custodialBucket.spec.ts's own header comment. (CUR-736/CUR-827)
import { describe, it, expect } from "vitest";
import { shadowUserId } from "$lib/chat/server/auth";
import { assertRagDocumentAccess, RagDocumentOwnershipError } from "./documentOwnership";

const UPLOADER = "uploaderBetterAuthId";
const OTHER_MEMBER = "otherMemberBetterAuthId";
const WORKSPACE_A = "org-a";
const WORKSPACE_B = "org-b";

describe("assertRagDocumentAccess", () => {
	it("allows the workspace admin regardless of who uploaded it", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: OTHER_MEMBER,
				actorIsWorkspaceAdmin: true,
				documentId: "doc-1",
				createdBy: await shadowUserId(UPLOADER),
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).resolves.toBeUndefined();
	});

	it("allows the admin even when createdBy is null (a seed/import document)", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: OTHER_MEMBER,
				actorIsWorkspaceAdmin: true,
				documentId: "doc-1",
				createdBy: null,
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).resolves.toBeUndefined();
	});

	it("allows the uploader, bridging Better Auth id to the doc-store shadow id", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: UPLOADER,
				actorIsWorkspaceAdmin: false,
				documentId: "doc-1",
				createdBy: await shadowUserId(UPLOADER),
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).resolves.toBeUndefined();
	});

	it("refuses a plain member who did not upload it", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: OTHER_MEMBER,
				actorIsWorkspaceAdmin: false,
				documentId: "doc-1",
				createdBy: await shadowUserId(UPLOADER),
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).rejects.toThrow(RagDocumentOwnershipError);
	});

	it("refuses a plain member against a null createdBy — no uploader to match, and not the admin", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: OTHER_MEMBER,
				actorIsWorkspaceAdmin: false,
				documentId: "doc-1",
				createdBy: null,
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).rejects.toThrow(RagDocumentOwnershipError);
	});

	it("never compares a raw Better Auth id straight against createdBy — that id space never matches", async () => {
		// If this ever accidentally compared actorUserId directly to createdBy instead of hashing first,
		// this would wrongly pass since UPLOADER as a raw string never equals its own shadow hash.
		await expect(
			assertRagDocumentAccess({
				actorUserId: UPLOADER,
				actorIsWorkspaceAdmin: false,
				documentId: "doc-1",
				createdBy: UPLOADER,
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_A,
			})
		).rejects.toThrow(RagDocumentOwnershipError);
	});

	// The cross-tenant IDOR. actorIsWorkspaceAdmin alone must not clear the check: it
	// has to compare which workspace the document actually belongs to, or an admin of workspace A,
	// passing workspace B's documentId, would pass. (CUR-929)
	it("refuses a workspace admin from a different workspace than the document's own — CUR-929", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: OTHER_MEMBER,
				actorIsWorkspaceAdmin: true,
				documentId: "doc-1",
				createdBy: await shadowUserId(UPLOADER),
				actorOrganizationId: WORKSPACE_A,
				documentOrganizationId: WORKSPACE_B,
			})
		).rejects.toThrow(RagDocumentOwnershipError);
	});

	// The workspace mismatch has to be disqualifying on its own, not just an extra condition folded
	// into the admin branch — the original uploader acting from the wrong workspace context is exactly
	// as unauthorized as an admin doing the same, since a document only ever belongs to one workspace.
	it("refuses even the document's own uploader when acting from a different workspace — CUR-929", async () => {
		await expect(
			assertRagDocumentAccess({
				actorUserId: UPLOADER,
				actorIsWorkspaceAdmin: false,
				documentId: "doc-1",
				createdBy: await shadowUserId(UPLOADER),
				actorOrganizationId: WORKSPACE_B,
				documentOrganizationId: WORKSPACE_A,
			})
		).rejects.toThrow(RagDocumentOwnershipError);
	});
});

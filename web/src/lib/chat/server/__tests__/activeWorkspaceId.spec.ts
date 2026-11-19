/**
 * A new conversation is attributed to the session's active workspace. The session's
 * activeOrganizationId is only a pointer: after the workspace was deleted it names a row that no
 * longer exists, and writing it into conversations.organization_id fails the foreign key and the
 * whole request with a 500. These tests seed real organization/member rows and check the
 * id is only returned while the person still belongs to an existing workspace; the session is stubbed.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { member, organization, user } from "$lib/chat/server/db/schema";
import { createTestLocals } from "$lib/chat/server/api/__tests__/testHelpers";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("$lib/chat/server/betterAuth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("$lib/chat/server/workspacesGate", () => ({ workspaceOrgCreationEnabled: () => false }));

const { activeWorkspaceIdFor } = await import("$lib/chat/server/currentWorkspace");

const run = crypto.randomUUID();
const userId = `aw-user-${run}`;
const orgA = `aw-org-a-${run}`;
const orgB = `aw-org-b-${run}`;
const gone = `aw-org-gone-${run}`;
const headers = new Headers({ cookie: "session=test" });
const signedIn = () => createTestLocals({ user: { name: "Ada" } as never });

function activeIs(organizationId: string | null) {
	getSession.mockResolvedValue({
		user: { id: userId },
		session: { activeOrganizationId: organizationId },
	});
}

describe.sequential("activeWorkspaceIdFor", () => {
	beforeEach(async () => {
		getSession.mockReset();
		const db = getDb();
		const now = new Date();
		await db.insert(user).values({ id: userId, name: "Ada", email: `${userId}@example.org` });
		await db.insert(organization).values([
			{ id: orgA, name: "Field team", slug: orgA, createdAt: now },
			{ id: orgB, name: "Someone else's", slug: orgB, createdAt: now },
		]);
		await db
			.insert(member)
			.values({ id: `aw-m-${run}`, organizationId: orgA, userId, role: "member", createdAt: now });
	});

	afterEach(async () => {
		const db = getDb();
		await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
		await db.delete(user).where(eq(user.id, userId));
	});

	it("returns the active workspace id while the person is a member of it", async () => {
		activeIs(orgA);
		expect(await activeWorkspaceIdFor(signedIn(), headers)).toBe(orgA);
	});

	it("returns undefined (Personal), not the stale id, when the active workspace no longer exists", async () => {
		activeIs(gone);
		expect(await activeWorkspaceIdFor(signedIn(), headers)).toBeUndefined();
	});

	it("returns undefined when the person was a member but the workspace was deleted under them", async () => {
		activeIs(orgA);
		await getDb().delete(organization).where(eq(organization.id, orgA));
		expect(await activeWorkspaceIdFor(signedIn(), headers)).toBeUndefined();
	});

	it("returns undefined when the session points at a workspace the person is not a member of", async () => {
		activeIs(orgB);
		expect(await activeWorkspaceIdFor(signedIn(), headers)).toBeUndefined();
	});

	it("returns undefined with no active workspace", async () => {
		activeIs(null);
		expect(await activeWorkspaceIdFor(signedIn(), headers)).toBeUndefined();
	});

	it("never reads the session for a guest", async () => {
		activeIs(orgA);
		expect(await activeWorkspaceIdFor(createTestLocals({ user: undefined }), headers)).toBeUndefined();
		expect(getSession).not.toHaveBeenCalled();
	});
});

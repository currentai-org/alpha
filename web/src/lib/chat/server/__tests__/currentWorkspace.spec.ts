/**
 * The account menu names the workspace new conversations count toward. The session's
 * activeOrganizationId is only a pointer, so these tests seed real organization/member rows and
 * check the name is read through the person's own membership: a workspace they left, or one that
 * was deleted under them (CUR-2835), names nothing. The session and the flag are stubbed; the
 * membership join is the contract, so it runs against the real tables. (CUR-3014)
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { member, organization, user } from "$lib/chat/server/db/schema";
import { createTestLocals } from "$lib/chat/server/api/__tests__/testHelpers";

const { getSession, flagOn } = vi.hoisted(() => ({
	getSession: vi.fn(),
	flagOn: vi.fn(() => true),
}));
vi.mock("$lib/chat/server/betterAuth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("$lib/chat/server/workspacesGate", () => ({ workspacesEnabled: flagOn, workspaceOrgCreationEnabled: () => false }));

const { workspaceScopeFor } = await import("$lib/chat/server/currentWorkspace");
const currentWorkspaceFor = async (locals: App.Locals, h: Headers) =>
	(await workspaceScopeFor(locals, h))?.current ?? null;

const run = crypto.randomUUID();
const userId = `cw-user-${run}`;
const orgA = `cw-org-a-${run}`;
const orgB = `cw-org-b-${run}`;
const headers = new Headers({ cookie: "session=test" });
const signedIn = () => createTestLocals({ user: { name: "Ada" } as never });

function activeIs(organizationId: string | null) {
	getSession.mockResolvedValue({
		user: { id: userId },
		session: { activeOrganizationId: organizationId },
	});
}

describe.sequential("currentWorkspaceFor (CUR-3014)", () => {
	beforeEach(async () => {
		flagOn.mockReturnValue(true);
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
			.values({ id: `cw-m-${run}`, organizationId: orgA, userId, role: "member", createdAt: now });
	});

	afterEach(async () => {
		const db = getDb();
		await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
		await db.delete(user).where(eq(user.id, userId));
	});

	it("names the active workspace when the person is a member of it", async () => {
		activeIs(orgA);
		expect(await currentWorkspaceFor(signedIn(), headers)).toEqual({ id: orgA, name: "Field team" });
	});

	it("names nothing when the session points at a workspace the person is not a member of", async () => {
		activeIs(orgB);
		expect(await currentWorkspaceFor(signedIn(), headers)).toBeNull();
	});

	it("names nothing once the person has left the active workspace", async () => {
		activeIs(orgA);
		await getDb().delete(member).where(eq(member.userId, userId));
		expect(await currentWorkspaceFor(signedIn(), headers)).toBeNull();
	});

	it("names nothing with no active workspace", async () => {
		activeIs(null);
		expect(await currentWorkspaceFor(signedIn(), headers)).toBeNull();
	});

	it("never reads the session when the workspaces flag is off", async () => {
		flagOn.mockReturnValue(false);
		activeIs(orgA);
		expect(await currentWorkspaceFor(signedIn(), headers)).toBeNull();
		expect(getSession).not.toHaveBeenCalled();
	});

	it("never reads the session for a guest", async () => {
		activeIs(orgA);
		expect(await currentWorkspaceFor(createTestLocals({ user: undefined }), headers)).toBeNull();
		expect(getSession).not.toHaveBeenCalled();
	});

	it("names nothing, rather than failing the chat shell, when the session read throws", async () => {
		getSession.mockRejectedValue(new Error("auth down"));
		expect(await currentWorkspaceFor(signedIn(), headers)).toBeNull();
	});
});

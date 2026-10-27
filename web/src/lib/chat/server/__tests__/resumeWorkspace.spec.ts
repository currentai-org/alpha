/**
 * A new session starts in the workspace the person last chose. The choice is kept on the
 * user row, and it is only handed back while the person is still a member of that workspace, so a
 * deleted workspace or a removal lands in Personal (CUR-3022). The flag is stubbed; the membership
 * join is the contract, so it runs against the real tables. (CUR-3024)
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "$lib/chat/server/db/client";
import { member, organization, user } from "$lib/chat/server/db/schema";

const { flagOn } = vi.hoisted(() => ({ flagOn: vi.fn(() => true) }));
vi.mock("$lib/chat/server/workspacesGate", () => ({ workspacesEnabled: flagOn }));

const { rememberActiveWorkspace, workspaceToResume } = await import("$lib/chat/server/resumeWorkspace");

const run = crypto.randomUUID();
const userId = `rw-user-${run}`;
const orgA = `rw-org-a-${run}`;
const orgB = `rw-org-b-${run}`;

async function lastChosen() {
	const [row] = await getDb()
		.select({ id: user.lastActiveOrganizationId })
		.from(user)
		.where(eq(user.id, userId));
	return row?.id;
}

describe.sequential("resumeWorkspace (CUR-3024)", () => {
	beforeEach(async () => {
		flagOn.mockReturnValue(true);
		const db = getDb();
		const now = new Date();
		await db.insert(user).values({ id: userId, name: "Ada", email: `${userId}@example.org` });
		await db.insert(organization).values([
			{ id: orgA, name: "Field team", slug: orgA, createdAt: now },
			{ id: orgB, name: "Someone else's", slug: orgB, createdAt: now },
		]);
		await db
			.insert(member)
			.values({ id: `rw-m-${run}`, organizationId: orgA, userId, role: "member", createdAt: now });
	});

	afterEach(async () => {
		const db = getDb();
		await db.delete(organization).where(inArray(organization.id, [orgA, orgB]));
		await db.delete(user).where(eq(user.id, userId));
	});

	it("resumes the workspace the person last chose while they are still a member of it", async () => {
		await rememberActiveWorkspace(userId, orgA);
		expect(await workspaceToResume(userId)).toBe(orgA);
	});

	it("records a return to Personal, so Personal is what resumes", async () => {
		await rememberActiveWorkspace(userId, orgA);
		await rememberActiveWorkspace(userId, null);
		expect(await lastChosen()).toBeNull();
		expect(await workspaceToResume(userId)).toBeNull();
	});

	it("resumes Personal (null) when the last choice is a workspace the person is not a member of", async () => {
		await rememberActiveWorkspace(userId, orgB);
		expect(await workspaceToResume(userId)).toBeNull();
	});

	it("resumes Personal (null) once the person has been removed from the last workspace", async () => {
		await rememberActiveWorkspace(userId, orgA);
		await getDb().delete(member).where(eq(member.userId, userId));
		expect(await workspaceToResume(userId)).toBeNull();
	});

	it("resumes Personal (null) once the last workspace has been deleted", async () => {
		await rememberActiveWorkspace(userId, orgA);
		await getDb().delete(organization).where(eq(organization.id, orgA));
		expect(await workspaceToResume(userId)).toBeNull();
	});

	it("resumes Personal (null) for someone who never chose a workspace", async () => {
		expect(await workspaceToResume(userId)).toBeNull();
	});

	it("neither records nor resumes anything when the workspaces flag is off", async () => {
		await rememberActiveWorkspace(userId, orgA);
		flagOn.mockReturnValue(false);
		await rememberActiveWorkspace(userId, null);
		expect(await lastChosen()).toBe(orgA);
		expect(await workspaceToResume(userId)).toBeNull();
	});
});

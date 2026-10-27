/**
 * Inviting your own address to a workspace is refused by Better Auth's organization plugin
 * (routes/crud-invites.mjs, findMemberByEmail → USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION) before
 * any invitation row exists. This app adds no check of its own on top; the settings page only turns
 * the plugin's code into plain words (memberErrorCopy). So the refusal is a property of the installed
 * plugin, and this file pins it against a Better Auth upgrade that drops or reorders that check.
 *
 * Real Postgres and the plugin's own endpoint, called with a real session cookie from its own
 * sign-up. The control case invites a different address and must create exactly one row, so the
 * zero-row assertion in the refusal case is a count that can go red. (CUR-3053)
 */
import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import { ORG_ROLES } from "./betterAuth";

function buildTestAuth() {
	return betterAuth({
		database: drizzleAdapter(getDb(), { provider: "pg", schema, usePlural: false }),
		secret: "test-only-secret-never-used-outside-this-spec-file-32ch",
		// Only so the spec can mint a session through the plugin's own sign-up; the app itself signs
		// in by email code and OAuth.
		emailAndPassword: { enabled: true },
		plugins: [
			organization({
				// The two settings from betterAuth.ts that the invite route reads.
				creatorRole: "admin",
				roles: ORG_ROLES,
				sendInvitationEmail: async () => {},
			}),
		],
	});
}

type TestAuth = ReturnType<typeof buildTestAuth>;

async function signUp(auth: TestAuth, email: string) {
	const { headers, response } = await auth.api.signUpEmail({
		body: { email, password: "test-only-password-1234", name: "Ada Lovelace" },
		returnHeaders: true,
	});
	const cookie = (headers.get("set-cookie") ?? "").split(";")[0];
	return { userId: response.user.id, headers: new Headers({ cookie }) };
}

async function workspaceWithAdmin(userId: string) {
	const db = getDb();
	const organizationId = newId();
	await db.insert(schema.organization).values({
		id: organizationId,
		name: "Self-invite test",
		slug: `self-invite-${organizationId}`,
		createdAt: new Date(),
	});
	await db
		.insert(schema.member)
		.values({ id: newId(), organizationId, userId, role: "admin", createdAt: new Date() });
	return organizationId;
}

async function invitationsFor(organizationId: string) {
	return getDb()
		.select({ email: schema.invitation.email })
		.from(schema.invitation)
		.where(eq(schema.invitation.organizationId, organizationId));
}

async function workspacesOf(userId: string) {
	return getDb()
		.select({ organizationId: schema.member.organizationId })
		.from(schema.member)
		.where(eq(schema.member.userId, userId));
}

describe.sequential("a workspace admin inviting their own address (CUR-3053)", () => {
	const userIds: string[] = [];
	const organizationIds: string[] = [];

	afterEach(async () => {
		const db = getDb();
		while (organizationIds.length)
			await db.delete(schema.organization).where(eq(schema.organization.id, organizationIds.pop()!));
		while (userIds.length) await db.delete(schema.user).where(eq(schema.user.id, userIds.pop()!));
	});

	it("is refused as already a member, and creates no invitation and no workspace", async () => {
		const auth = buildTestAuth();
		const email = `self-invite-${newId()}@example.org`;
		const { userId, headers } = await signUp(auth, email);
		userIds.push(userId);
		const organizationId = await workspaceWithAdmin(userId);
		organizationIds.push(organizationId);

		await expect(
			auth.api.createInvitation({ headers, body: { email, role: "member", organizationId } })
		).rejects.toMatchObject({ body: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" } });

		expect(await invitationsFor(organizationId)).toEqual([]);
		expect(await workspacesOf(userId)).toEqual([{ organizationId }]);
	});

	it("control: inviting a different address from the same workspace does create one invitation", async () => {
		const auth = buildTestAuth();
		const { userId, headers } = await signUp(auth, `self-invite-${newId()}@example.org`);
		userIds.push(userId);
		const organizationId = await workspaceWithAdmin(userId);
		organizationIds.push(organizationId);
		const other = `invitee-${newId()}@example.org`;

		await auth.api.createInvitation({ headers, body: { email: other, role: "member", organizationId } });

		expect(await invitationsFor(organizationId)).toEqual([{ email: other }]);
	});
});

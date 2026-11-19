/**
 * The mail a real workspace invite produces, read at the last point this app controls: the request
 * it hands Resend. Nobody can read a received invite (the walker inbox has no reader, and our Resend
 * keys are send-only), so this is the nearest check to "what arrives".
 *
 * It runs the organization plugin's own invite endpoint, with a real session cookie, on real
 * Postgres, wired to the app's own `sendInvitationEmailFromPlugin` hook. So the inviter named in the
 * mail is whatever the plugin hands that hook for the signed-in account, not a value the spec typed.
 * betterAuth.sendWorkspaceInvitationEmail.spec.ts covers the mail function alone; this covers the
 * wiring in front of it. Only `fetch` is replaced, so nothing leaves the process.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { getDb } from "$lib/chat/server/db/client";
import * as schema from "$lib/chat/server/db/schema";
import { newId } from "$lib/chat/server/db/ids";
import { base } from "$lib/chat/paths";

// A send-ready deployment: Resend configured, a public origin for the accept link. Every other key
// reads through to the real config.
vi.mock("$lib/chat/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/chat/server/config")>();
	const overrides: Record<string, string> = {
		RESEND_API_KEY: "re_spec_only_never_sent",
		PUBLIC_ORIGIN: "https://alpha.example.net",
	};
	return {
		...actual,
		config: new Proxy(actual.config, {
			get(target, prop, receiver) {
				if (typeof prop === "string" && prop in overrides) return overrides[prop];
				return Reflect.get(target, prop, receiver);
			},
		}),
	};
});

const sent: { url: string; body: Record<string, unknown> }[] = [];
vi.stubGlobal(
	"fetch",
	vi.fn(async (url: string, init?: RequestInit) => {
		if (url !== "https://api.resend.com/emails") throw new Error(`unexpected fetch in spec: ${url}`);
		sent.push({ url, body: JSON.parse(String(init?.body)) });
		return new Response(JSON.stringify({ id: "spec-resend-id" }), { status: 200 });
	})
);

async function buildTestAuth() {
	const { ORG_ROLES, sendInvitationEmailFromPlugin } = await import("./betterAuth");
	return betterAuth({
		database: drizzleAdapter(getDb(), { provider: "pg", schema, usePlural: false }),
		secret: "test-only-secret-never-used-outside-this-spec-file-32ch",
		// Only so the spec can mint a session through the plugin's own sign-up; the app itself signs
		// in by email code and OAuth.
		emailAndPassword: { enabled: true },
		plugins: [
			organization({
				creatorRole: "admin",
				roles: ORG_ROLES,
				sendInvitationEmail: sendInvitationEmailFromPlugin,
			}),
		],
	});
}

describe.sequential("the mail a real workspace invite sends", () => {
	const userIds: string[] = [];
	const organizationIds: string[] = [];

	afterEach(async () => {
		sent.length = 0;
		const db = getDb();
		while (organizationIds.length)
			await db.delete(schema.organization).where(eq(schema.organization.id, organizationIds.pop()!));
		while (userIds.length) await db.delete(schema.user).where(eq(schema.user.id, userIds.pop()!));
	});

	it("has a subject naming no workspace and a body that opens with the inviter's own account email", async () => {
		const auth = await buildTestAuth();
		const inviterEmail = `inviter-${newId()}@example.org`;
		const { headers, response } = await auth.api.signUpEmail({
			body: { email: inviterEmail, password: "test-only-password-1234", name: "Ada Lovelace" },
			returnHeaders: true,
		});
		userIds.push(response.user.id);
		const cookie = new Headers({ cookie: (headers.get("set-cookie") ?? "").split(";")[0] });

		const db = getDb();
		const organizationId = newId();
		const workspaceName = "Claim your prize now";
		await db.insert(schema.organization).values({
			id: organizationId,
			name: workspaceName,
			slug: `invite-mail-${organizationId}`,
			createdAt: new Date(),
		});
		organizationIds.push(organizationId);
		await db
			.insert(schema.member)
			.values({ id: newId(), organizationId, userId: response.user.id, role: "admin", createdAt: new Date() });

		// Not the reserved test domain, which is suppressed before any send.
		const invitee = `invitee-${newId()}@example.net`;
		await auth.api.createInvitation({ headers: cookie, body: { email: invitee, role: "member", organizationId } });

		const [invitation] = await db
			.select({ id: schema.invitation.id })
			.from(schema.invitation)
			.where(eq(schema.invitation.organizationId, organizationId));
		expect(invitation).toBeDefined();

		expect(sent).toHaveLength(1);
		const mail = sent[0].body;
		expect(mail.to).toEqual([invitee]);
		expect(mail.subject).toBe("You've been invited to a workspace on Alpha");
		expect(String(mail.subject)).not.toContain(workspaceName);
		expect(String(mail.text).startsWith(`${inviterEmail} invited you to join the workspace "${workspaceName}"`)).toBe(
			true
		);
		expect(String(mail.text)).toContain(`https://alpha.example.net${base}/workspace/accept/${invitation.id}`);
		expect(String(mail.text)).toContain(`If you don't know ${inviterEmail}, you can ignore this email.`);
	});
});

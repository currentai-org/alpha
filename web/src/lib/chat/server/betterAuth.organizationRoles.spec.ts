/**
 * This app's workspace admin (Better Auth's "admin" role, assigned via creatorRole in betterAuth.ts)
 * has to be able to delete its own workspace (CUR-827). Better Auth's BUILT-IN admin role cannot
 * (plugins/organization/access/statement.mjs): adminAc grants `organization: ["update"]` only,
 * "delete" is owner-only, and this app never assigns "owner" (its two roles are admin and member).
 * Without ORG_ROLES, every admin calling the plugin's own /organization/delete gets FORBIDDEN.
 *
 * ORG_ROLES is imported directly from betterAuth.ts, not re-derived here — it's the literal object
 * passed as `roles` into the organization({...}) plugin config, so this test fails if that wiring is
 * ever dropped, not just if the role's own permission list regresses.
 *
 * A plain object import — no live DB needed. buildAuth()/getAuth() are what eagerly call getDb(); this
 * file never touches either, same lazy-init testability as sendVerificationOTP/sendWorkspaceInvitationEmail's
 * own spec files.
 */
import { describe, it, expect } from "vitest";
import { ORG_ROLES } from "./betterAuth";

describe("workspace ORG_ROLES (CUR-827)", () => {
	it("grants the app's admin role permission to delete its own workspace", () => {
		expect(ORG_ROLES.admin.authorize({ organization: ["delete"] }).success).toBe(true);
	});

	it("keeps every admin ability CUR-550 already shipped — invite, remove, cancel", () => {
		expect(ORG_ROLES.admin.authorize({ invitation: ["create", "cancel"] }).success).toBe(true);
		expect(ORG_ROLES.admin.authorize({ member: ["create", "update", "delete"] }).success).toBe(true);
	});

	it("still refuses a plain member — the fix widens admin only, not the whole role model", () => {
		expect(ORG_ROLES.member.authorize({ organization: ["delete"] }).success).toBe(false);
	});
});

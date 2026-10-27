import { describe, expect, test } from "vitest";

import { isSignedOut, pageErrorText, resolveOrganizationsState } from "./orgsState";

const SIGNED_OUT_COPY = "You're signed out. Sign in again to manage your workspaces.";

describe("resolveOrganizationsState", () => {
	test("org creation off: resolves to zero orgs with no error, without attempting a list call", () => {
		// Pinned as a contract: this deployment's organization routes are refused categorically when org creation
		// is off, so this must never look like an errored fetch. It is the expected, intended state that unlocks
		// the personal-workspace view (`orgs.length === 0 && !workspaceOrgCreationEnabled` in +page.svelte).
		expect(resolveOrganizationsState(false)).toEqual({ orgs: [], orgsError: "" });
	});

	test("org creation on, list call errors: surfaces the error and leaves orgs null", () => {
		const result = resolveOrganizationsState(true, {
			data: null,
			error: { message: "network down" }
		});
		expect(result).toEqual({ orgs: null, orgsError: "network down" });
	});

	test("org creation on, list call errors with no message: falls back to a generic message", () => {
		const result = resolveOrganizationsState(true, { data: null, error: {} });
		expect(result).toEqual({ orgs: null, orgsError: "Couldn't load your workspaces." });
	});

	test("org creation on, list call succeeds with orgs: passes the rows through untouched", () => {
		const orgs = [{ id: "o1", name: "Acme", slug: "acme", joinMethod: "invite", configChangeRule: "admin" }];
		const result = resolveOrganizationsState(true, { data: orgs, error: null });
		expect(result).toEqual({ orgs, orgsError: "" });
	});

	test("org creation on, list call succeeds with null data: normalizes to an empty array", () => {
		const result = resolveOrganizationsState(true, { data: null, error: null });
		expect(result).toEqual({ orgs: [], orgsError: "" });
	});
});

describe("isSignedOut", () => {
	test("only a 401 ends the page's workspace controls; a refusal or an outage leaves them (CUR-4108)", () => {
		expect(isSignedOut({ status: 401, message: "Unauthorized" })).toBe(true);
		expect(isSignedOut({ status: 403, message: "Only an admin can do that" })).toBe(false);
		expect(isSignedOut({ status: 500 })).toBe(false);
		expect(isSignedOut({ message: undefined })).toBe(false);
		expect(isSignedOut(null)).toBe(false);
	});
});

describe("pageErrorText", () => {
	test('a 401 says the person is signed out, never Better Auth\'s bare "Unauthorized" (CUR-3280)', () => {
		expect(pageErrorText({ status: 401, message: "Unauthorized" }, "Couldn't load that workspace.")).toBe(
			SIGNED_OUT_COPY
		);
	});

	test("any other refusal keeps its own message, or the fallback when it has none", () => {
		expect(pageErrorText({ status: 403, message: "Only an admin can do that" }, "x")).toBe(
			"Only an admin can do that"
		);
		expect(pageErrorText({ status: 500 }, "Couldn't load that workspace.")).toBe(
			"Couldn't load that workspace."
		);
	});

	test("a 401 from the workspace list reads as signed out too", () => {
		const result = resolveOrganizationsState(true, {
			data: null,
			error: { status: 401, message: "Unauthorized" }
		});
		expect(result).toEqual({ orgs: null, orgsError: SIGNED_OUT_COPY });
	});
});

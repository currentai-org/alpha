import { describe, it, expect } from "vitest";
import {
	JOIN_METHODS,
	CONFIG_CHANGE_RULES,
	RULES_VISIBILITIES,
	joinMethodLabel,
	configChangeRuleLabel,
	joinMethodRefusal,
	workspaceNameRefusal,
	WORKSPACE_NAME_MAX,
} from "./workspacePermissions";

describe("workspacePermissions (CUR-826)", () => {
	it("labels every declared join method — a value with no label is a gap this test catches", () => {
		for (const value of JOIN_METHODS) {
			expect(joinMethodLabel(value)).not.toBe(value);
		}
	});

	it("labels every declared config-change rule", () => {
		for (const value of CONFIG_CHANGE_RULES) {
			expect(configChangeRuleLabel(value)).not.toBe(value);
		}
	});

	it("falls back to the raw value for an unrecognized switch value, never a blank", () => {
		expect(joinMethodLabel("some-future-value")).toBe("some-future-value");
		expect(configChangeRuleLabel("some-future-value")).toBe("some-future-value");
	});

	it("the first entry in each list is the schema default declared in betterAuth.ts and schema.ts", () => {
		// Defaults must match the shipped behavior exactly. This pin keeps betterAuth.ts's `defaultValue:
		// JOIN_METHODS[0]` (etc.) honest against a reorder of this list.
		expect(JOIN_METHODS[0]).toBe("invitation");
		expect(CONFIG_CHANGE_RULES[0]).toBe("admin_only");
		expect(RULES_VISIBILITIES[0]).toBe("always");
	});
});

describe("joinMethodRefusal (CUR-3021)", () => {
	it("refuses request and open, which have no join flow, in workspace words", () => {
		for (const value of ["request", "open"]) {
			const message = joinMethodRefusal(value);
			expect(message).toMatch(/invitation only/);
			expect(message).not.toMatch(/organization|owner/i);
		}
	});

	it("refuses a value that is not a join method at all, so a typo cannot be stored either", () => {
		expect(joinMethodRefusal("anyone")).not.toBeNull();
		expect(joinMethodRefusal(null)).not.toBeNull();
	});

	it("allows invitation, and leaves an update that does not touch the join method alone", () => {
		expect(joinMethodRefusal("invitation")).toBeNull();
		expect(joinMethodRefusal(undefined)).toBeNull();
	});
});

// The name goes into an email a stranger receives, so the check that matters is what it
// refuses, and the control cases are ordinary team names that must still pass. (CUR-3194)
describe("workspaceNameRefusal (CUR-3194)", () => {
	it("refuses a name carrying a link, a web address or an email address", () => {
		for (const name of [
			"Win big at https://spam.example",
			"visit www.spam",
			"Prizes at bit.ly/abc",
			"claim-now.com",
			"write to prize@spam.example",
		]) {
			expect(workspaceNameRefusal(name), name).toMatch(/link|address/);
		}
	});

	it("refuses a name over the limit, an empty one, and one hiding control characters", () => {
		expect(workspaceNameRefusal("a".repeat(WORKSPACE_NAME_MAX + 1))).toMatch(/up to 60/);
		expect(workspaceNameRefusal("   ")).not.toBeNull();
		expect(workspaceNameRefusal("Team\nClick here")).not.toBeNull();
		expect(workspaceNameRefusal("Team\u202eevil")).not.toBeNull();
	});

	it("allows ordinary team names, and an update that does not touch the name", () => {
		for (const name of ["Design team", "Dept. of Health", "R&D (Zürich)", "a".repeat(WORKSPACE_NAME_MAX)]) {
			expect(workspaceNameRefusal(name), name).toBeNull();
		}
		expect(workspaceNameRefusal(undefined)).toBeNull();
	});
});

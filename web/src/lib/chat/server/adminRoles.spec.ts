import { describe, it, expect } from "vitest";
import { roleGrants, seesDeveloperTools, type AdminPermission } from "./adminRoles";

// Which staff role may do what in /chat/admin. Each list is the whole of what a role must
// hold; the `withheld` lists are the grants that would leak visitor data or let a role change what
// visitors get, so a widened role goes red here. (CUR-3990)
const ALL: AdminPermission[] = [
	{ console: "view" },
	{ tuning: "try" },
	{ tuning: "save" },
	{ rag: "write" },
	{ reports: "read" },
	{ config: "read" },
	{ user: "set-role" },
	{ user: "ban" },
	{ user: "impersonate" },
];

const held: Record<string, AdminPermission[]> = {
	operator: [{ console: "view" }, { tuning: "try" }],
	editor: [{ console: "view" }, { tuning: "try" }, { tuning: "save" }, { rag: "write" }],
	admin: [
		{ console: "view" },
		{ tuning: "try" },
		{ tuning: "save" },
		{ rag: "write" },
		{ reports: "read" },
		{ config: "read" },
		{ user: "set-role" },
		{ user: "ban" },
	],
};

const key = (p: AdminPermission) => JSON.stringify(p);

describe("adminRoles: each staff role holds exactly its own grants", () => {
	for (const [role, grants] of Object.entries(held)) {
		const want = new Set(grants.map(key));
		for (const p of ALL) {
			const expected = want.has(key(p));
			it(`${role} ${expected ? "holds" : "is refused"} ${key(p)}`, () => {
				expect(roleGrants(role, p)).toBe(expected);
			});
		}
	}

	it("an operator cannot save tuning, write RAG or read reports", () => {
		for (const p of [{ tuning: "save" }, { rag: "write" }, { reports: "read" }] as const) {
			expect(roleGrants("operator", p)).toBe(false);
		}
	});

	it("an editor cannot read visitors' reports or the config dump", () => {
		expect(roleGrants("editor", { reports: "read" })).toBe(false);
		expect(roleGrants("editor", { config: "read" })).toBe(false);
	});

	it("no role can impersonate, so the plugin's impersonation is off", () => {
		for (const role of ["user", "operator", "editor", "admin"]) {
			expect(roleGrants(role, { user: "impersonate" })).toBe(false);
		}
	});
});

describe("roleGrants: a missing or unknown role grants nothing (fail closed)", () => {
	it("null, empty, the default `user` role and an unknown name grant nothing", () => {
		for (const role of [null, undefined, "", "user", "superuser", "constructor", "__proto__"]) {
			expect(roleGrants(role, { console: "view" })).toBe(false);
		}
	});

	it("a comma-joined role list grants what any one of its roles holds", () => {
		expect(roleGrants("user, editor", { tuning: "save" })).toBe(true);
		expect(roleGrants("user,operator", { tuning: "save" })).toBe(false);
	});
});

// Settings' developer tools follow the staff roles, so they don't need the shared password. (CUR-3992)
describe("seesDeveloperTools", () => {
	it("opens for every staff role and the legacy admin flag, and stays shut for a plain or unknown role", () => {
		expect(seesDeveloperTools(true, undefined)).toBe(true);
		for (const role of ["operator", "editor", "admin", "user,editor"]) expect(seesDeveloperTools(false, role)).toBe(true);
		for (const role of [undefined, null, "", "user", "owner", "superuser"]) expect(seesDeveloperTools(false, role)).toBe(false);
	});
});

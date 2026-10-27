// Per-person roles for the /chat/admin area (CUR-3990, under CUR-927).
//
// Better Auth's admin plugin stores one `role` string on each user row; this file says what each role
// may do. Three staff roles, each a superset of the one before:
//
// * operator: read-only admin views, plus tuning `try` and `mini-eval` against a draft that nobody
//   else sees.
// * editor: operator, plus changes to what visitors get: tuning saves and RAG writes. No visitor
//   data.
// * admin: editor, plus visitors' reports, the debug config dump, and managing other people's roles.
//
// Impersonation is granted to no role, which is how the plugin turns it off.

import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";

const adminStatements = {
	...defaultStatements,
	console: ["view"],
	tuning: ["try", "save"],
	rag: ["write"],
	reports: ["read"],
	config: ["read"],
} as const;

export const adminAc = createAccessControl(adminStatements);

const operatorGrants = {
	console: ["view"],
	tuning: ["try"],
} as const;

const editorGrants = {
	...operatorGrants,
	tuning: ["try", "save"],
	rag: ["write"],
} as const;

const adminGrants = {
	...editorGrants,
	reports: ["read"],
	config: ["read"],
	user: ["list", "get", "set-role", "ban"],
	session: ["list", "revoke"],
} as const;

export const adminRoles = {
	user: adminAc.newRole({}),
	operator: adminAc.newRole(operatorGrants),
	editor: adminAc.newRole(editorGrants),
	admin: adminAc.newRole(adminGrants),
};

type AdminRole = keyof typeof adminRoles;

type Statements = typeof adminStatements;
/** One capability an admin route needs, e.g. `{ tuning: "save" }`. */
export type AdminPermission = {
	[R in keyof Statements]: { [K in R]: Statements[R][number] };
}[keyof Statements];

/**
 * Whether a stored role string grants a permission. The plugin stores several roles comma-joined;
 * any one granting it is enough. An unknown role grants nothing.
 */
export function roleGrants(role: string | null | undefined, permission: AdminPermission): boolean {
	if (!role) return false;
	const request = Object.fromEntries(Object.entries(permission).map(([resource, action]) => [resource, [action]]));
	return role
		.split(",")
		.map((r) => r.trim())
		.some((r) => Object.hasOwn(adminRoles, r) && adminRoles[r as AdminRole].authorize(request).success);
}

/**
 * Whether Settings shows this person the developer tools (per-model pages and switches): the legacy
 * admin flag, or any staff role that may view the admin console (CUR-3992). Without the second half a
 * role holder signed in as themselves never sees them.
 */
export function seesDeveloperTools(isAdmin: boolean, role: string | null | undefined): boolean {
	return isAdmin || roleGrants(role, { console: "view" });
}

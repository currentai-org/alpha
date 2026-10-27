// Gate for the admin area (/admin/* — portal, reports, safety, RAG console, tuning, journeys, audit).
//
// A person signs in with their own Better Auth account, and the role on that account decides what
// they may do (adminRoles.ts, CUR-3990). The shared ADMIN_USER / ADMIN_PASSWORD login and its `admin`
// proof cookie are gone (CUR-3992), because every deployment held the same password. A browser still
// holding an old `admin` cookie is treated as signed out.

import { error, type Cookies } from "@sveltejs/kit";
import { roleGrants, type AdminPermission } from "$lib/chat/server/adminRoles";

/** The request's own cookies and locals. Only `locals` is read; `cookies` stays so every caller keeps its shape. */
type AdminRequest = { cookies: Cookies; locals: App.Locals };

/** Who to name in the admin audit log: the signed-in person's email, else their username. */
export async function adminActor(_cookies: Cookies, locals?: App.Locals): Promise<string> {
	return locals?.user?.email ?? locals?.user?.username ?? "admin";
}

/** Whether this request may use `permission`: a signed-in person whose role grants it. */
export async function isAdminPermitted(
	input: AdminRequest,
	permission: AdminPermission
): Promise<boolean> {
	return roleGrants(input.locals.user?.role, permission);
}

/**
 * Hard gate for an action or endpoint that needs `permission`. Passes a role holder; 403 to a
 * signed-in person whose role lacks it; 401 to everyone else.
 */
export async function requireAdminPermission(
	input: AdminRequest,
	permission: AdminPermission
): Promise<void> {
	if (await isAdminPermitted(input, permission)) return;
	if (input.locals.user) error(403, "Your role does not allow this.");
	error(401, "Sign in to the admin area.");
}

import { error } from "@sveltejs/kit";

/**
 * Throws 401 if neither a user._id nor sessionId is present in locals.
 */
export function requireAuth(locals: App.Locals): void {
	if (!locals.user?._id && !locals.sessionId) {
		error(401, "Must have a valid session or user");
	}
}

/**
 * requireAuth() alone accepts a bare guest session — fine for content that has a guest/session-scoped
 * case (conversations, settings, ...). Some features (CUR-1262's local inference endpoints) don't: a
 * guest has no account to attach a local server to at all. Use this instead of requireAuth() for those,
 * and use the returned id as the row's userId — the same shadow `users.id` authCondition()/every other
 * per-user table keys on, never Better Auth's own `user.id` directly.
 */
export function requireUserId(locals: App.Locals): string {
	requireAuth(locals);
	if (!locals.user?._id) {
		error(401, "Sign in required");
	}
	return locals.user._id.toString();
}

import { goto } from "$app/navigation";
import { base } from "$lib/chat/paths";
import { page } from "$app/state";

/**
 * Redirects to the login page if the user is not authenticated
 * and sign-in is actually MANDATORY here — not merely configured.
 *
 * loginEnabled alone means "sign-in is offered" (the `accounts` flag, CUR-246). automaticLogin is
 * the separate, deliberate toggle (config.AUTOMATIC_LOGIN) that turns "offered" into "required", and
 * handle.ts's two server-side force-login gates require BOTH. This client gate must require both
 * too: checking loginEnabled alone force-redirects anonymous visitors to /login on every chat action
 * wherever sign-in is merely offered, even though the server-side gates stay optional.
 */
export function requireAuthUser(): boolean {
	if (page.data.loginEnabled && page.data.automaticLogin && !page.data.user) {
		const next = page.url.pathname + page.url.search;
		const url = `${base}/login?next=${encodeURIComponent(next)}`;
		goto(url, { invalidateAll: true });
		return true;
	}
	return false;
}

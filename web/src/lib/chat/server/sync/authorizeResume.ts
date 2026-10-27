import { AUTH_BASE_PATH, base } from "$lib/chat/paths";

/** Parameters the oauth-provider plugin adds when it signs a query; the authorize endpoint wants none. */
const SIGNING_PARAMS = new Set(["sig", "exp", "ba_iat", "ba_pl", "ba_param"]);

/**
 * Where the plugin's login redirect sends a signed-out visitor. Alpha's sign-in page knows
 * nothing of the plugin's signed query, so this rebuilds the original authorize request from it and
 * hands that to /login as `next`: once signed in, the browser goes back to authorize, which now finds
 * a session and carries on to consent. `prompt` is dropped, since signing in just now satisfies
 * `prompt=login` and keeping it would send the visitor round again. (CUR-4312)
 */
export function authorizeResumePath(signedQuery: URLSearchParams): string {
	const params = new URLSearchParams();
	for (const [k, v] of signedQuery) {
		if (!SIGNING_PARAMS.has(k) && k !== "prompt") params.append(k, v);
	}
	return `${AUTH_BASE_PATH}/oauth2/authorize?${params.toString()}`;
}

/** The /login URL that returns to `authorizeResumePath` afterwards. */
export function signInForAuthorize(signedQuery: URLSearchParams): string {
	return `${base}/login?next=${encodeURIComponent(authorizeResumePath(signedQuery))}`;
}

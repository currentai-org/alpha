/**
 * Better Auth's BROWSER client (CUR-434) — pairs with the server instance in
 * server/betterAuth.ts. Client-side only: never import this from server code (it pulls in
 * @simplewebauthn/browser's WebAuthn calls, which need `navigator.credentials`).
 *
 * No `baseURL` passed — confirmed against the installed package's own client/config.mjs:
 * with `baseURL` unset, `getBaseURL()` falls through to `window.location.origin`, and since this is
 * always browser code that's exactly the right origin. Only `basePath` needs to match the server's
 * `basePath: AUTH_BASE_PATH` (betterAuth.ts) and the catch-all route's own location
 * (routes/chat/api/auth/[...all]/+server.ts).
 *
 * Hugging Face doesn't get its own client plugin — confirmed from the installed generic-oauth plugin's
 * own doc comment ("Providers are used through the standard `signIn.social` and `callback/:id` core
 * endpoints — no plugin-specific endpoints needed"), so `signIn.social({ provider: "huggingface" })`
 * reaches it the same way as Google/GitHub, no extra plugin required.
 */
import { createAuthClient } from "better-auth/svelte";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";
import { AUTH_BASE_PATH } from "$lib/chat/paths";

// The login page starts a silent autofill passkey ceremony on mount, and the "Use a
// passkey" button starts a second one. Both share one challenge cookie, and a verify consumes the
// row it names, so two live ceremonies make the second verify fail with "Challenge not found".
// simplewebauthn aborts the previous ceremony when a new one starts, but only once the previous one
// has reached navigator.credentials.get, which happens just after its options request answers. The
// passkey client gives no hook on that request, so these global ones count it in flight, and
// passkeyOptionsSettled() lets the button wait until none is. (CUR-2695)
const AUTHENTICATE_OPTIONS_PATH = "/passkey/generate-authenticate-options";
const OPTIONS_WAIT_CAP_MS = 5_000;
let optionsInFlight = 0;
let optionsWaiters: (() => void)[] = [];

function isAuthenticateOptions(url: unknown): boolean {
	return String(url).includes(AUTHENTICATE_OPTIONS_PATH);
}

function optionsAnswered() {
	optionsInFlight = Math.max(0, optionsInFlight - 1);
	if (optionsInFlight > 0) return;
	for (const resolve of optionsWaiters) resolve();
	optionsWaiters = [];
}

/**
 * Resolves once no passkey options request is in flight. A fetch that rejects never reaches the
 * response hook, so the wait is capped rather than trusted to end.
 */
export function passkeyOptionsSettled(): Promise<void> {
	if (optionsInFlight === 0) return Promise.resolve();
	return new Promise((resolve) => {
		optionsWaiters.push(resolve);
		setTimeout(resolve, OPTIONS_WAIT_CAP_MS);
	});
}

export const authClient = createAuthClient({
	// Pinned like the server's basePath (CUR-4448): Better Auth answers only under AUTH_BASE_PATH.
	basePath: AUTH_BASE_PATH,
	fetchOptions: {
		onRequest(context) {
			if (isAuthenticateOptions(context.url)) optionsInFlight++;
		},
		onResponse(context) {
			if (isAuthenticateOptions(context.request.url)) optionsAnswered();
		},
	},
	// organizationClient (CUR-550) needs no options — creatorRole/roles live server-side only
	// (betterAuth.ts); this just gives the dynamic path-proxy `authClient.organization.*` its shape.
	plugins: [passkeyClient(), emailOTPClient(), organizationClient()],
});

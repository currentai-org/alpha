// Better Auth's own OAUTH_CALLBACK_ERROR_CODES (better-auth/dist/oauth2/errors.mjs) and the
// space-to-underscore `result.error` codes from api/routes/callback.mjs — the vocabulary a failed OAuth
// callback can land on this app with, whether the failure came from the explicit "link a provider"
// flow (account settings) or a fresh sign-in that collided with an existing account (login page,
// CUR-850). One mapping shared by both surfaces so the codes can't drift into two different readings
// of the same failure.

/** Maps a Better Auth OAuth-callback error code to copy a person can act on. Unlisted codes still show
 *  something specific rather than a generic failure — same "never drop it silently" posture as
 *  friendlyOtpError on the login page. */
export function friendlyAuthErrorMessage(code: string): string {
	switch (code) {
		case "email_does_not_match":
			return "That account's email doesn't match the email on your current sign-in, so it wasn't linked.";
		case "email_not_found":
			return "That provider didn't share an email address, so there was nothing to match against your account.";
		case "email_not_verified":
			return "That provider's email isn't verified yet — verify it there, then try linking again.";
		case "unable_to_link_account":
			return "Couldn't link that account. Try again in a moment.";
		case "account_already_linked_to_different_user":
			return "That provider account is already linked to a different account.";
		// disableImplicitLinking turns a same-email cross-provider sign-in into an explicit refusal
		// instead of a silent merge (CUR-850); this is what that refusal looks like from here.
		// Deliberately doesn't name which provider the existing account uses; the client only has the
		// error code, not that account's identity.
		case "account_not_linked":
			return "An account with this email already exists. Sign in the way you originally did, then add this as another way in from Settings → Account.";
		// Better Auth's state.mjs remaps its internal "state_security_mismatch" to this code before
		// it reaches us. The usual cause is the provider's account picker taking longer than the state
		// cookie's 5-minute window. Nothing failed, so the copy says so plainly rather than
		// surfacing the raw code.
		case "state_mismatch":
			return "That took a little too long and the link expired. Try again.";
		// The person backed out of the provider's consent screen. The provider sends
		// `error=access_denied` and Better Auth forwards it here unchanged. Nothing changed, so the copy
		// says that, on the sign-in page and the link flow alike. (CUR-2793)
		case "access_denied":
			return "You cancelled at the provider, so nothing changed. Try again when you're ready.";
		default:
			return `Linking failed (${code}). Try again in a moment.`;
	}
}

/** The `{code, message}` a failed `authClient.signIn.passkey()` returns. */
export type PasskeyError = { code?: string; message?: string };

// Better Auth's passkey client gives every ceremony failure the same message, "Auth
// cancelled": the browser's NotAllowedError (no passkey on this device, the dialog dismissed, or its
// timeout), each SimpleWebAuthn `ERROR_*` code, and a verify call that threw. That message does not say what to do instead, so those
// failures get copy that names the other ways in, built from the providers this deployment offers.
// An error from the options request is the server's own and keeps its message. (CUR-2924)
export function friendlyPasskeyError(error: PasskeyError, providers: string[]): string {
	const code = error.code ?? "";
	if (code === "AUTH_CANCELLED" || code.startsWith("ERROR_")) {
		const ways = ["email", ...providers];
		const list = ways.length > 1 ? `${ways.slice(0, -1).join(", ")} or ${ways[ways.length - 1]}` : ways[0];
		return `No passkey was used. If this device doesn't have one for Alpha, sign in with ${list} below.`;
	}
	return error.message ?? "Couldn't start passkey sign-in. Try again in a moment.";
}

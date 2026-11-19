// A guest who chatted on www or chat. keeps their conversations when chat moves to alpha.
//
// A guest has no account: their conversations belong to the value of a host-only cookie, and alpha
// cannot read www's cookies. The source host reads its own cookie and hands it to alpha in an
// auto-submitting POST (the shape of OAuth's form_post response mode), sealed with AES-256-GCM and
// good for one minute. alpha opens it and sets the same value as its own cookie, so the guest's
// conversations and files are theirs on alpha with nothing moved in the database.
//
// Why a POST body and not a redirect URL: a URL lands in history, logs and Referer headers, and this
// value is the guest's whole session. Why the Origin check: without it, another site could post its
// own guest's sealed value and plant that session in a visitor's browser, then read what they type.
// A browser always sends Origin on a cross-origin POST and no page can forge it.
//
// alpha never replaces a guest cookie that holds a conversation or a file; one with at most a settings
// row gives way and its settings are lost. It does nothing for a visitor signed in there.
import type { Cookies } from "@sveltejs/kit";
import { chatHome } from "$lib/chat/paths";
import { GUEST_HANDOFF_SOURCE_HOSTS } from "$lib/chat/wwwChatRedirect";
import { isReplaceableGuestSession, refreshSessionCookie, sanitizeReturnPath, sessionCookieName } from "$lib/chat/server/auth";
import { open, SealedSecretError } from "$lib/chat/server/storage/locations/sealedSecret";
import { GUEST_HANDOFF_INFO, GUEST_TOKEN, guestHandoffSecrets } from "$lib/chat/server/guestHandoffPage";

/** What the chat host did with a handoff, for the log. */
export type HandoffOutcome =
	| "adopted"
	| "replaced-empty-guest"
	| "bad-origin"
	| "unreadable"
	| "expired"
	| "has-guest"
	| "signed-in";

/**
 * Take a guest session posted from a source host and set it as this host's guest cookie. Every
 * outcome returns the page to 303 to; only "adopted" and "replaced-empty-guest" set anything.
 */
export async function acceptGuestHandoff(
	request: Request,
	cookies: Cookies,
	now = Date.now()
): Promise<{ next: string; outcome: HandoffOutcome }> {
	const origin = request.headers.get("origin");
	const allowed = GUEST_HANDOFF_SOURCE_HOSTS.map((host) => `https://${host}`);
	const form = await request.formData().catch(() => null);
	const next = sanitizeReturnPath(form?.get("next")?.toString()) ?? chatHome;
	// Lands them anyway, so a browser that withholds Origin costs the guest their history, not the page.
	if (!origin || !allowed.includes(origin)) return { next, outcome: "bad-origin" };

	const sealed = form?.get("h")?.toString();
	let payload: { token?: unknown; expiresAt?: unknown };
	try {
		payload = JSON.parse(openUnderAnySecret(sealed));
	} catch (e) {
		if (e instanceof SealedSecretError || e instanceof SyntaxError) return { next, outcome: "unreadable" };
		throw e;
	}
	const { token, expiresAt } = payload;
	if (typeof token !== "string" || !GUEST_TOKEN.test(token) || typeof expiresAt !== "number") {
		return { next, outcome: "unreadable" };
	}
	if (expiresAt < now) return { next, outcome: "expired" };
	// Before the guest check: a signed-in visitor's session cookie can hold the Better Auth token, which
	// owns no rows by sessionId and would otherwise read as an empty guest.
	if (cookies.getAll().some(({ name }) => name.endsWith(".session_token"))) return { next, outcome: "signed-in" };
	const existing = cookies.get(sessionCookieName);
	if (existing && existing !== token) {
		// A guest session alpha holds with no conversation gives way, even when it has a
		// settings row (dismissing the welcome modal writes one). The visitor loses alpha's settings for
		// that session and keeps the conversations they bring. One with a conversation is never replaced.
		if (!(await isReplaceableGuestSession(existing))) return { next, outcome: "has-guest" };
		refreshSessionCookie(cookies, token);
		return { next, outcome: "replaced-empty-guest" };
	}

	refreshSessionCookie(cookies, token);
	return { next, outcome: "adopted" };
}

// A source host seals with GUEST_HANDOFF_SECRET once it has one, and with BETTER_AUTH_SECRET before
// that, so the chat host tries each it holds.
function openUnderAnySecret(sealed: string | undefined): string {
	const secrets = guestHandoffSecrets();
	if (!sealed || secrets.length === 0) throw new SealedSecretError("nothing to open");
	for (const secret of secrets) {
		try {
			return open(sealed, secret, GUEST_HANDOFF_INFO);
		} catch (e) {
			if (!(e instanceof SealedSecretError)) throw e;
		}
	}
	throw new SealedSecretError("sealed under none of this host's secrets");
}

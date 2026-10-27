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
// row gives way and its settings are lost (CUR-4445). It does nothing for a visitor signed in there. (CUR-4439)
import { createHash } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { CHAT_HOST, GUEST_HANDOFF_PATH, chatHome } from "$lib/chat/paths";
import { GUEST_HANDOFF_SOURCE_HOSTS } from "$lib/chat/wwwChatRedirect";
import { config } from "$lib/chat/server/config";
import { isReplaceableGuestSession, refreshSessionCookie, sanitizeReturnPath, sessionCookieName } from "$lib/chat/server/auth";
import { open, seal, SealedSecretError } from "$lib/chat/server/storage/locations/sealedSecret";

const INFO = "aipotluck/guest-host-handoff/v1";
const TTL_MS = 60_000;
// A guest cookie is a uuid, or a uuid plus its base64url signature (guestSession.ts).
const GUEST_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;

const SUBMIT_SCRIPT = "document.getElementById('handoff').submit();";
const SUBMIT_SCRIPT_HASH = `'sha256-${createHash("sha256").update(SUBMIT_SCRIPT).digest("base64")}'`;

const escapeAttr = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page that carries this guest's session to the chat host and lands them on `target` there, or
 * null when there is nothing to carry: no guest cookie, or no secret to seal it with.
 */
export function guestHandoffPage(cookies: Pick<Cookies, "get">, target: URL, now = Date.now()): Response | null {
	const token = cookies.get(sessionCookieName);
	const secret = config.BETTER_AUTH_SECRET;
	if (!token || !GUEST_TOKEN.test(token) || !secret) return null;

	const sealed = seal(JSON.stringify({ token, expiresAt: now + TTL_MS }), secret, INFO);
	const action = `https://${CHAT_HOST}${GUEST_HANDOFF_PATH}`;
	const next = `${target.pathname}${target.search}`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Alpha has moved</title></head><body><form id="handoff" method="post" action="${escapeAttr(action)}"><input type="hidden" name="h" value="${escapeAttr(sealed)}"><input type="hidden" name="next" value="${escapeAttr(next)}"><p>Alpha now lives at ${escapeAttr(CHAT_HOST)}.</p><noscript><button type="submit">Continue to Alpha</button></noscript></form><script>${SUBMIT_SCRIPT}</script></body></html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			// Not no-referrer: under that policy a browser sends `Origin: null` on this POST, and alpha
			// would refuse it. strict-origin sends the origin alone, never the path.
			"referrer-policy": "strict-origin",
			"x-robots-tag": "noindex",
			"content-security-policy": `default-src 'none'; script-src ${SUBMIT_SCRIPT_HASH}; form-action https://${CHAT_HOST}; base-uri 'none'; frame-ancestors 'none'`,
		},
	});
}

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

	const secret = config.BETTER_AUTH_SECRET;
	const sealed = form?.get("h")?.toString();
	let payload: { token?: unknown; expiresAt?: unknown };
	try {
		if (!secret || !sealed) throw new SealedSecretError("nothing to open");
		payload = JSON.parse(open(sealed, secret, INFO));
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
		// that session and keeps the conversations they bring. One with a conversation is never replaced. (CUR-4445)
		if (!(await isReplaceableGuestSession(existing))) return { next, outcome: "has-guest" };
		refreshSessionCookie(cookies, token);
		return { next, outcome: "replaced-empty-guest" };
	}

	refreshSessionCookie(cookies, token);
	return { next, outcome: "adopted" };
}

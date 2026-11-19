// The source half of the guest handoff (guestHandoff.ts has the whole story): www or chat. seals the
// guest's own cookie value into a page that posts it to the chat host. Kept apart from the chat host's
// half, which reads the database through auth.ts, so a site-only www builds this page with
// none of chat's request chain loaded.
//
// The seal's key is GUEST_HANDOFF_SECRET, set to the same value on www and alpha, so www needs no
// BETTER_AUTH_SECRET once it serves no chat. While a host holds BETTER_AUTH_SECRET it seals under that,
// as before; the chat host opens a value under either (guestHandoffSecrets).
import { createHash } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { CHAT_HOST, GUEST_HANDOFF_PATH } from "$lib/chat/paths";
import { config } from "$lib/chat/server/config";
import { sessionCookieName } from "$lib/chat/server/sessionCookieName";
import { seal } from "$lib/chat/server/storage/locations/sealedSecret";

export const GUEST_HANDOFF_INFO = "aipotluck/guest-host-handoff/v1";
const TTL_MS = 60_000;
// A guest cookie is a uuid, or a uuid plus its base64url signature (guestSession.ts).
export const GUEST_TOKEN = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The secrets a handoff may be sealed under, the one a source host seals with first. BETTER_AUTH_SECRET
 * leads while a host still holds it, so giving www GUEST_HANDOFF_SECRET before alpha has it changes
 * nothing; www seals under its own key only once BETTER_AUTH_SECRET has left, by which time alpha must
 * hold GUEST_HANDOFF_SECRET too.
 */
export function guestHandoffSecrets(): string[] {
	return [config.BETTER_AUTH_SECRET, config.GUEST_HANDOFF_SECRET].filter((s): s is string => !!s);
}

const SUBMIT_SCRIPT = "document.getElementById('handoff').submit();";
const SUBMIT_SCRIPT_HASH = `'sha256-${createHash("sha256").update(SUBMIT_SCRIPT).digest("base64")}'`;

const escapeAttr = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The page that carries this guest's session to the chat host and lands them on `target` there, or
 * null when there is nothing to carry: no chat host, no guest cookie, or no secret to seal it with.
 */
export function guestHandoffPage(cookies: Pick<Cookies, "get">, target: URL, now = Date.now()): Response | null {
	const token = cookies.get(sessionCookieName);
	const [secret] = guestHandoffSecrets();
	const chatHost = CHAT_HOST;
	if (!chatHost || !token || !GUEST_TOKEN.test(token) || !secret) return null;

	const sealed = seal(JSON.stringify({ token, expiresAt: now + TTL_MS }), secret, GUEST_HANDOFF_INFO);
	const action = `https://${chatHost}${GUEST_HANDOFF_PATH}`;
	const next = `${target.pathname}${target.search}`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Alpha has moved</title></head><body><form id="handoff" method="post" action="${escapeAttr(action)}"><input type="hidden" name="h" value="${escapeAttr(sealed)}"><input type="hidden" name="next" value="${escapeAttr(next)}"><p>Alpha now lives at ${escapeAttr(chatHost)}.</p><noscript><button type="submit">Continue to Alpha</button></noscript></form><script>${SUBMIT_SCRIPT}</script></body></html>`;

	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			// Not no-referrer: under that policy a browser sends `Origin: null` on this POST, and alpha
			// would refuse it. strict-origin sends the origin alone, never the path.
			"referrer-policy": "strict-origin",
			"x-robots-tag": "noindex",
			"content-security-policy": `default-src 'none'; script-src ${SUBMIT_SCRIPT_HASH}; form-action https://${chatHost}; base-uri 'none'; frame-ancestors 'none'`,
		},
	});
}

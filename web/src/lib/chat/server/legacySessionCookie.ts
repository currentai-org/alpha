import type { Cookies } from "@sveltejs/kit";

// production's session cookies before they became host-only. Each carried
// Domain=aipotluck.org, so a browser sent them to every host under the apex, develop and third-party
// hosts included. They are never read again; a production response that sees one expires it on the
// apex, which is the only scope that can clear it. (CUR-4442)
const LEGACY_PRODUCTION_COOKIES = [
	"__Secure-better-auth.session_token",
	"__Secure-better-auth.session_data",
	"__Secure-better-auth.dont_remember",
] as const;

const LEGACY_DOMAIN = "aipotluck.org";

export function expireLegacySessionCookies(
	cookies: Pick<Cookies, "get" | "delete"> | undefined,
	env: { VERCEL_ENV?: string }
): void {
	if (!cookies || env.VERCEL_ENV !== "production") return;
	for (const name of LEGACY_PRODUCTION_COOKIES) {
		if (cookies.get(name) === undefined) continue;
		cookies.delete(name, { path: "/", domain: LEGACY_DOMAIN, secure: true, httpOnly: true, sameSite: "lax" });
	}
}

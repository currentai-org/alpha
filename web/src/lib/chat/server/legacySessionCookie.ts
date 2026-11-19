import type { Cookies } from "@sveltejs/kit";
import { DEPLOYMENT } from "$lib/deployment";
import { deployEnvName, type RuntimeEnv } from "$lib/server/runtimeEnv";

// production's session cookies before they became host-only. Each carried Domain=<apex>
// (apexDomain, src/lib/deployment.ts), so a browser sent them to every host under the apex, develop and
// third-party hosts included. They are never read again; a production response that sees one expires
// it on the apex, which is the only scope that can clear it. With no apex there is nothing to expire.
const LEGACY_PRODUCTION_COOKIES = [
	"__Secure-better-auth.session_token",
	"__Secure-better-auth.session_data",
	"__Secure-better-auth.dont_remember",
] as const;

const LEGACY_DOMAIN = DEPLOYMENT.apexDomain;

export function expireLegacySessionCookies(
	cookies: Pick<Cookies, "get" | "delete"> | undefined,
	env: RuntimeEnv
): void {
	if (!cookies || !LEGACY_DOMAIN || deployEnvName(env) !== "production") return;
	for (const name of LEGACY_PRODUCTION_COOKIES) {
		if (cookies.get(name) === undefined) continue;
		cookies.delete(name, { path: "/", domain: LEGACY_DOMAIN, secure: true, httpOnly: true, sameSite: "lax" });
	}
}

import { describe, expect, it } from "vitest";
import type { Cookies } from "@sveltejs/kit";
import { expireLegacySessionCookies } from "$lib/chat/server/legacySessionCookie";

type Deleted = { name: string; opts: Parameters<Cookies["delete"]>[1] };

function cookieJar(present: Record<string, string>): { cookies: Cookies; deleted: Deleted[] } {
	const deleted: Deleted[] = [];
	const cookies = {
		get: (name: string) => present[name],
		delete: (name: string, opts: Parameters<Cookies["delete"]>[1]) => deleted.push({ name, opts }),
	} as unknown as Cookies;
	return { cookies, deleted };
}

// production's old session cookies carried Domain=aipotluck.org. A delete without that
// Domain would clear a different cookie and leave the apex one reaching every subdomain. (CUR-4442)
describe("expireLegacySessionCookies", () => {
	it("expires the old production session cookie on the apex Domain it was set with", () => {
		const { cookies, deleted } = cookieJar({ "__Secure-better-auth.session_token": "tok.sig" });
		expireLegacySessionCookies(cookies, { VERCEL_ENV: "production" });
		expect(deleted).toEqual([
			{
				name: "__Secure-better-auth.session_token",
				opts: { path: "/", domain: "aipotluck.org", secure: true, httpOnly: true, sameSite: "lax" },
			},
		]);
	});

	it("leaves the new __Host- cookie and unrelated cookies alone", () => {
		const { cookies, deleted } = cookieJar({ "__Host-aip.session_token": "tok.sig", "hf-chat": "x" });
		expireLegacySessionCookies(cookies, { VERCEL_ENV: "production" });
		expect(deleted).toEqual([]);
	});

	it("does nothing outside production, so develop never clears a production cookie", () => {
		const { cookies, deleted } = cookieJar({ "__Secure-better-auth.session_token": "tok.sig" });
		expireLegacySessionCookies(cookies, { VERCEL_ENV: "preview" });
		expireLegacySessionCookies(cookies, {});
		expect(deleted).toEqual([]);
	});
});

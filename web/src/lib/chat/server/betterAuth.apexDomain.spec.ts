import { describe, expect, it } from "vitest";
import {
	APEX_DOMAIN,
	PRODUCTION_COOKIE_PREFIX,
	isApexOrSubdomain,
	computeOriginIsApexOrSubdomain,
	computeSessionCookieScope,
	computePasskeyRp,
} from "$lib/chat/server/betterAuth";

// passkeyRpId is pinned to the apex only when this returns true (CUR-697); the session cookie is
// host-only regardless (CUR-4442). A credential scoped to the exact hostname would not carry to a
// sibling subdomain (chat.aipotluck.org / alpha.aipotluck.org) after a split, and a WebAuthn
// credential already registered narrow can't be widened after the fact.
describe("isApexOrSubdomain", () => {
	it("matches the apex itself", () => {
		expect(isApexOrSubdomain(APEX_DOMAIN)).toBe(true);
	});

	it("matches a subdomain of the apex", () => {
		expect(isApexOrSubdomain("chat.aipotluck.org")).toBe(true);
		expect(isApexOrSubdomain("alpha.aipotluck.org")).toBe(true);
	});

	// A naive `.includes` or unanchored suffix check would also match this — a different domain that
	// merely ends with the same characters, with no subdomain-separating dot. Pinning THIS hostname's
	// cookie/RP-ID to "aipotluck.org" would be scoping a credential to a domain the browser never
	// actually served it from.
	it("does not match a different domain that happens to end with the same string", () => {
		expect(isApexOrSubdomain("notaipotluck.org")).toBe(false);
	});

	it("does not match a preview deploy or local dev host", () => {
		expect(isApexOrSubdomain("aipotluck-org-git-branch-current-ai.vercel.app")).toBe(false);
		expect(isApexOrSubdomain("localhost")).toBe(false);
	});

	it("does not match undefined (PUBLIC_ORIGIN unset, e.g. local dev)", () => {
		expect(isApexOrSubdomain(undefined)).toBe(false);
	});
});

// The pin-to-apex decision follows the per-deployment signal, not
// isApexOrSubdomain(publicOriginHostname): PUBLIC_ORIGIN is the same `preview` value on every preview
// deployment regardless of which branch built it, so that check is always true. An ephemeral per-PR
// preview would inherit "pin to the apex" from develop.aipotluck.org's own config, send Better Auth's
// session cookie with Domain=aipotluck.org from a *.vercel.app response, and Chromium would discard
// it, so a signed-in visitor loses their session on the next navigation. These pin the per-deployment signal. (CUR-1172)
describe("computeOriginIsApexOrSubdomain", () => {
	it("is true on a real production deployment", () => {
		expect(computeOriginIsApexOrSubdomain({ VERCEL_ENV: "production" })).toBe(true);
	});

	it("is true on develop's own aliased deployment", () => {
		expect(computeOriginIsApexOrSubdomain({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "develop" })).toBe(
			true
		);
	});

	it("is false on an ephemeral per-PR preview, even though it shares develop's PUBLIC_ORIGIN", () => {
		expect(
			computeOriginIsApexOrSubdomain({
				VERCEL_ENV: "preview",
				VERCEL_GIT_COMMIT_REF: "dev/some-feature-branch",
			})
		).toBe(false);
	});

	it("is false off Vercel entirely (local dev, both vars unset)", () => {
		expect(computeOriginIsApexOrSubdomain({})).toBe(false);
	});
});

// Production and develop both wrote Better Auth's default-named session cookie with
// Domain=aipotluck.org, so a sign-in on one overwrote the other's and signed the visitor out there.
// Every deployment now gets its own name and a host-only scope (production since CUR-4442), so none
// can overwrite or read another's cookie. (CUR-1904)
const PRODUCTION_SCOPE = {
	cookiePrefix: PRODUCTION_COOKIE_PREFIX,
	useSecureCookies: false,
	defaultCookieAttributes: { secure: true },
};

describe("computeSessionCookieScope", () => {
	// host-only, so no other aipotluck.org host receives a production session. (CUR-4442)
	it("gives production a host-only __Host- cookie with no apex Domain", () => {
		expect(computeSessionCookieScope({ VERCEL_ENV: "production" })).toEqual(PRODUCTION_SCOPE);
	});

	// INSTANCE unset, blank or www is www itself. (CUR-3156)
	it("gives www production's scope when INSTANCE is unset, blank or www", () => {
		for (const INSTANCE of [undefined, "", "www"]) {
			expect(computeSessionCookieScope({ VERCEL_ENV: "production", INSTANCE })).toEqual(PRODUCTION_SCOPE);
		}
	});

	// An event instance is production on its own database; on the apex under production's name, its
	// sign-in would overwrite www's session cookie with one www's database doesn't know.
	it("gives an event instance in production its own name, host-only, so it cannot sign www out", () => {
		expect(computeSessionCookieScope({ VERCEL_ENV: "production", INSTANCE: "mozfest" })).toEqual({
			cookiePrefix: "aip-mozfest",
		});
	});

	it("refuses an INSTANCE that isn't a lowercase label rather than falling back to www's apex cookie", () => {
		expect(() => computeSessionCookieScope({ VERCEL_ENV: "production", INSTANCE: "MozFest 2026" })).toThrow(
			/INSTANCE/
		);
	});

	it("gives develop a different cookie name, host-only, so it cannot sign production out", () => {
		const develop = computeSessionCookieScope({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "develop" });
		expect(develop.cookiePrefix).not.toBe(PRODUCTION_COOKIE_PREFIX);
		expect("crossSubDomainCookies" in develop).toBe(false);
	});

	it("gives an ephemeral per-PR preview and local dev the same non-production name, host-only", () => {
		for (const env of [{ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "dev/some-branch" }, {}]) {
			const scope = computeSessionCookieScope(env);
			expect(scope.cookiePrefix).not.toBe(PRODUCTION_COOKIE_PREFIX);
			expect("crossSubDomainCookies" in scope).toBe(false);
		}
	});
});

// A per-PR preview must take its passkey RP ID from its own host, not from PUBLIC_ORIGIN
// (develop's shared hostname). The browser on the preview's own *.vercel.app host refuses a registration
// whose RP ID names another domain ("The RP ID develop.aipotluck.org is invalid for this domain"). The RP
// ID and a trusted origin have to name the host the browser is actually on. (CUR-1708)
describe("computePasskeyRp", () => {
	const develop = "https://develop.aipotluck.org";

	it("names the PR preview's own host, never develop's, so registration can succeed there", () => {
		const rp = computePasskeyRp(
			{ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "dev/x", VERCEL_URL: "aipotluck-abc123.vercel.app" },
			develop
		);
		expect(rp.rpID).toBe("aipotluck-abc123.vercel.app");
		expect(rp.origins).toContain("https://aipotluck-abc123.vercel.app");
	});

	it("keeps the apex on develop's own deployment, whatever its VERCEL_URL", () => {
		const rp = computePasskeyRp(
			{ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "develop", VERCEL_URL: "aipotluck-dev.vercel.app" },
			develop
		);
		expect(rp.rpID).toBe(APEX_DOMAIN);
		expect(rp.origins).not.toContain("https://aipotluck-dev.vercel.app");
	});

	it("keeps the apex on production", () => {
		expect(
			computePasskeyRp({ VERCEL_ENV: "production", VERCEL_URL: "x.vercel.app" }, "https://www.aipotluck.org").rpID
		).toBe(APEX_DOMAIN);
	});

	// An event instance's database holds none of www's passkeys, so it registers its own host. (CUR-3156)
	it("names an event instance's own host in production, never the apex", () => {
		const rp = computePasskeyRp(
			{ VERCEL_ENV: "production", INSTANCE: "mozfest", VERCEL_URL: "x.vercel.app" },
			"https://mozfest.aipotluck.org"
		);
		expect(rp).toEqual({ rpID: "mozfest.aipotluck.org", origins: ["https://mozfest.aipotluck.org"] });
	});

	it("keeps the apex in production when INSTANCE is unset", () => {
		expect(computePasskeyRp({ VERCEL_ENV: "production", INSTANCE: "" }, "https://www.aipotluck.org").rpID).toBe(
			APEX_DOMAIN
		);
	});

	it("leaves both unset in local dev, so the plugin's localhost defaults apply", () => {
		expect(computePasskeyRp({}, undefined)).toEqual({ rpID: undefined, origins: undefined });
	});
});

import { describe, expect, it } from "vitest";
import { getCookies } from "better-auth/cookies";
import { computeSessionCookieScope } from "$lib/chat/server/betterAuth";

// Which hosts receive production's session cookie. The attributes come from Better Auth's
// own cookie builder, fed the scope production runs with, so this reads what the library emits rather
// than a restatement of our config.
//
// A cookie carrying a Domain attribute goes to that domain and all its subdomains; one without goes
// only back to the host that set it (RFC 6265 §5.1.3 domain-match, §5.3 step 6).
// status.aipotluck.org is a CNAME to a third-party status page (Better Stack), and cms.aipotluck.org
// is a separate app, so neither should ever receive a signed-in person's session.
// (CUR-1910)
// production's cookie is host-only, so it reaches neither. With the apex Domain it had
// before (CUR-697), every "never sent" case below fails. (CUR-4442)
function sentTo(host: string, cookie: { attributes: { domain?: string } }, setBy: string): boolean {
	const domain = cookie.attributes.domain?.replace(/^\./, "").toLowerCase();
	if (!domain) return host === setBy;
	return host === domain || host.endsWith(`.${domain}`);
}

const productionSession = getCookies({
	baseURL: "https://www.aipotluck.org",
	advanced: computeSessionCookieScope({ VERCEL_ENV: "production" }),
}).sessionToken;

describe("production session cookie reach", () => {
	it("reaches the host that serves chat", () => {
		expect(sentTo("www.aipotluck.org", productionSession, "www.aipotluck.org")).toBe(true);
	});

	it("is never sent to status.aipotluck.org, a third-party status page", () => {
		expect(sentTo("status.aipotluck.org", productionSession, "www.aipotluck.org")).toBe(false);
	});

	it("is never sent to cms.aipotluck.org, a separate app", () => {
		expect(sentTo("cms.aipotluck.org", productionSession, "www.aipotluck.org")).toBe(false);
	});

	it("is never sent to develop.aipotluck.org, where unshipped code runs", () => {
		expect(sentTo("develop.aipotluck.org", productionSession, "alpha.aipotluck.org")).toBe(false);
	});

	// A __Host- cookie must be Secure, Path=/ and carry no Domain, or the browser drops it; the prefix is
	// what stops a subdomain planting a same-name cookie on Domain=aipotluck.org.
	it("is a __Host- cookie the browser will accept: Secure, Path=/, no Domain", () => {
		expect(productionSession.name).toBe("__Host-aip.session_token");
		expect(productionSession.attributes.secure).toBe(true);
		expect(productionSession.attributes.path).toBe("/");
		expect(productionSession.attributes.domain).toBeUndefined();
	});

	// Control: a preview's host-only cookie stays on its own host under the same helper.
	it("a host-only cookie (the preview scope) stays on its own host", () => {
		const hostOnly = getCookies({
			baseURL: "https://www.aipotluck.org",
			advanced: computeSessionCookieScope({ VERCEL_ENV: "preview" }),
		}).sessionToken;
		expect(sentTo("www.aipotluck.org", hostOnly, "www.aipotluck.org")).toBe(true);
		expect(sentTo("status.aipotluck.org", hostOnly, "www.aipotluck.org")).toBe(false);
	});
});

// What Better Auth actually emits on an event instance. It reads its own name, so it never
// picks a www session up, and its own cookie never travels back to www. (CUR-3156)
describe("event instance session cookie", () => {
	const mozfest = getCookies({
		baseURL: "https://mozfest.aipotluck.org",
		advanced: computeSessionCookieScope({ VERCEL_ENV: "production", INSTANCE: "mozfest" }),
	}).sessionToken;

	it("has its own name, distinct from production's", () => {
		expect(mozfest.name).toBe("__Secure-aip-mozfest.session_token");
		expect(mozfest.name).not.toBe(productionSession.name);
	});

	it("stays on the instance's host and never reaches www", () => {
		expect(mozfest.attributes.domain).toBeUndefined();
		expect(sentTo("mozfest.aipotluck.org", mozfest, "mozfest.aipotluck.org")).toBe(true);
		expect(sentTo("www.aipotluck.org", mozfest, "mozfest.aipotluck.org")).toBe(false);
	});
});

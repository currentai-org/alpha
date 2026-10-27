import { describe, expect, it } from "vitest";
import { getCookies } from "better-auth/cookies";
import { resolveBaseURL } from "better-auth";
import { authBaseURL, authOrigins } from "$lib/chat/server/authOrigins";
import { computeSessionCookieScope } from "$lib/chat/server/betterAuth";

const WWW = "https://www.aipotluck.org";
const CHAT_HOST = "alpha.aipotluck.org";
const PRODUCTION = { VERCEL_ENV: "production" };
const PREVIEW = { VERCEL_ENV: "preview" };

function requestTo(host: string): Request {
	return new Request(`https://${host}/chat/api/auth/sign-in/social`, { headers: { host } });
}

// Production serves chat on www. and alpha. (chat's own host, CUR-4439) at once, and sign-in has to answer on whichever
// host the visitor used. (CUR-1067)
describe("authOrigins", () => {
	it("answers on www and alpha in production, PUBLIC_ORIGIN first", () => {
		expect(authOrigins(WWW, PRODUCTION)).toEqual([WWW, `https://${CHAT_HOST}`]);
	});

	// alpha.'s OAuth callbacks exist only on the production Google and GitHub clients.
	it("stays on PUBLIC_ORIGIN alone on preview", () => {
		expect(authOrigins("https://develop.aipotluck.org", PREVIEW)).toEqual(["https://develop.aipotluck.org"]);
	});

	// alpha. is an alias of www alone, so an event instance answers on its own host only. (CUR-3156)
	it("answers on an event instance's own host only, never alpha.", () => {
		const mozfest = "https://mozfest.aipotluck.org";
		expect(authOrigins(mozfest, { ...PRODUCTION, INSTANCE: "mozfest" })).toEqual([mozfest]);
	});

	it("keeps alpha. in production when INSTANCE is unset or www", () => {
		expect(authOrigins(WWW, { ...PRODUCTION, INSTANCE: "" })).toEqual([WWW, `https://${CHAT_HOST}`]);
		expect(authOrigins(WWW, { ...PRODUCTION, INSTANCE: "www" })).toEqual([WWW, `https://${CHAT_HOST}`]);
	});

	// A chat-surface build is chat's own deployment; its PUBLIC_ORIGIN is the one auth origin. (CUR-4448)
	it("answers on the chat-surface deployment's own PUBLIC_ORIGIN alone, never adding www's alpha. alias", () => {
		const alphaDevelop = "https://alpha-develop.aipotluck.org";
		expect(authOrigins(alphaDevelop, PRODUCTION, "chat")).toEqual([alphaDevelop]);
		expect(authOrigins(`https://${CHAT_HOST}`, PRODUCTION, "chat")).toEqual([`https://${CHAT_HOST}`]);
		expect(authBaseURL(alphaDevelop, PRODUCTION, "chat")).toBe(alphaDevelop);
	});

	it("is empty when PUBLIC_ORIGIN is unset (local dev)", () => {
		expect(authOrigins(undefined, PRODUCTION)).toEqual([]);
	});
});

describe("authBaseURL", () => {
	it("stays the static PUBLIC_ORIGIN string outside production", () => {
		expect(authBaseURL("https://develop.aipotluck.org", PREVIEW)).toBe("https://develop.aipotluck.org");
		expect(authBaseURL(undefined, PREVIEW)).toBeUndefined();
	});

	// The behaviour is Better Auth's own resolver fed our config, so this checks what a request actually
	// gets back rather than the shape of the object.
	it("sends an alpha. request's OAuth callback back to alpha.", () => {
		const config = authBaseURL(WWW, PRODUCTION);
		expect(resolveBaseURL(config, "/chat/api/auth", requestTo(CHAT_HOST))).toBe(
			`https://${CHAT_HOST}/chat/api/auth`
		);
	});

	it("keeps a www request on www", () => {
		const config = authBaseURL(WWW, PRODUCTION);
		expect(resolveBaseURL(config, "/chat/api/auth", requestTo("www.aipotluck.org"))).toBe(
			`${WWW}/chat/api/auth`
		);
	});

	// A spoofed or unlisted Host must not become a redirect_uri or a trusted origin.
	it("falls back to PUBLIC_ORIGIN for a host outside the allowlist", () => {
		const config = authBaseURL(WWW, PRODUCTION);
		expect(resolveBaseURL(config, "/chat/api/auth", requestTo("evil.example"))).toBe(`${WWW}/chat/api/auth`);
		expect(resolveBaseURL(config, "/chat/api/auth", requestTo("aipotluck-org-current-ai.vercel.app"))).toBe(
			`${WWW}/chat/api/auth`
		);
	});

	// The dynamic baseURL must not change the cookie, or production's `__Host-` name and its
	// host-only scope would differ between www and alpha. (CUR-4442)
	it("gives production the same host-only __Host- session cookie under the dynamic baseURL", () => {
		const advanced = computeSessionCookieScope(PRODUCTION);
		const before = getCookies({ baseURL: WWW, advanced }).sessionToken;
		const after = getCookies({ baseURL: authBaseURL(WWW, PRODUCTION), advanced }).sessionToken;
		expect(after.name).toBe("__Host-aip.session_token");
		expect(after.name).toBe(before.name);
		expect(after.attributes.domain).toBeUndefined();
		expect(after.attributes.secure).toBe(true);
	});
});

import { describe, it, expect } from "vitest";
import { agentTokenExpiry } from "./agentTokenExpiry";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2ln`;
const NOW = Date.parse("2026-11-22T00:00:00Z");

describe("agentTokenExpiry", () => {
	it("reads the expiry date and days left from the token's exp claim", () => {
		const exp = Date.parse("2027-01-19T21:56:00Z") / 1000;
		const e = agentTokenExpiry(jwt({ sub: "chat", exp }), NOW);
		expect(e?.expiresAt).toBe("2027-01-19T21:56:00.000Z");
		expect(Math.floor(e!.daysLeft)).toBe(58);
	});

	it("gives negative days left for a token already past its exp", () => {
		const e = agentTokenExpiry(jwt({ exp: NOW / 1000 - 86_400 }), NOW);
		expect(e!.daysLeft).toBeCloseTo(-1);
	});

	it.each([
		["an empty token", ""],
		["an opaque self-host token", "s3cret-not-a-jwt"],
		["a JWT with no exp", jwt({ sub: "chat" })],
		["a JWT whose exp is not a number", jwt({ exp: "soon" })],
		["a JWT whose payload is not JSON", `${b64({})}.bm90IGpzb24.c2ln`],
	])("returns null (records nothing) for %s", (_label, token) => {
		expect(agentTokenExpiry(token, NOW)).toBeNull();
	});
});

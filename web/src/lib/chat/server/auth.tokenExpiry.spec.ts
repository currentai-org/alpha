import { describe, it, expect } from "vitest";
import { tokenSetToSessionOauth, type OIDCTokens } from "$lib/chat/server/auth";

// Written for the openid-client v5 -> v6 migration (CUR-211), and specifically for the one change in
// it that a type error would NOT have caught.
//
// v5's TokenSet carried `expires_at`, an absolute unix timestamp. v6 removed that field and returns
// `expires_in` — relative seconds — plus an `expiresIn()` helper. Both spellings are plausible to a
// reader, both compile against a loosely-typed mock, and reading the wrong one returns `undefined`
// rather than throwing. `tokenSetToSessionOauth` then falls through to its two-week default, so every
// session silently outlives its access token, and because `getSessionUser` only refreshes when the
// recorded expiry is inside five minutes, the refresh path never runs either.
//
// Nothing else asserts on this function, and it is the kind of defect that ships green.

function tokens(overrides: Partial<Record<string, unknown>> = {}): OIDCTokens {
	return {
		access_token: "at",
		refresh_token: "rt",
		token_type: "bearer",
		expiresIn: () => 3600,
		claims: () => undefined,
		...overrides,
	} as unknown as OIDCTokens;
}

describe("tokenSetToSessionOauth", () => {
	it("derives the session expiry from the token's OWN lifetime, not the two-week fallback", () => {
		const before = Date.now();
		const oauth = tokenSetToSessionOauth(tokens({ expiresIn: () => 3600 }));
		const after = Date.now();

		expect(oauth).toBeDefined();
		const expiresAt = oauth?.token.expiresAt.getTime() ?? 0;

		// One hour out, less the one-minute safety margin the function applies.
		expect(expiresAt).toBeGreaterThanOrEqual(before + 3600_000 - 60_000);
		expect(expiresAt).toBeLessThanOrEqual(after + 3600_000 - 60_000);

		// The assertion that actually catches the regression: a fortnight away means we read a field
		// v6 does not set and silently took the fallback.
		expect(expiresAt).toBeLessThan(before + 24 * 3600_000);
	});

	it("still falls back to two weeks when the provider genuinely reports no expiry", () => {
		// A real case, and the reason the fallback exists at all — distinct from the failure above,
		// where the value is absent because we asked for the wrong thing.
		const before = Date.now();
		const oauth = tokenSetToSessionOauth(tokens({ expiresIn: () => undefined }));

		const expiresAt = oauth?.token.expiresAt.getTime() ?? 0;
		expect(expiresAt).toBeGreaterThan(before + 13 * 24 * 3600_000);
	});

	it("shortens the recorded expiry so it lands before the token actually dies", () => {
		// The subMinutes(…, 1) margin. If it inverted, the session would be considered live for a
		// minute after the provider stopped honouring the token.
		const now = Date.now();
		const oauth = tokenSetToSessionOauth(tokens({ expiresIn: () => 600 }));
		expect(oauth?.token.expiresAt.getTime()).toBeLessThan(now + 600_000);
	});

	it("returns undefined without an access token rather than a session with an empty credential", () => {
		expect(tokenSetToSessionOauth(tokens({ access_token: undefined }))).toBeUndefined();
	});

	it("carries the refresh token through, since losing it silently disables renewal", () => {
		expect(tokenSetToSessionOauth(tokens())?.refreshToken).toBe("rt");
		expect(tokenSetToSessionOauth(tokens({ refresh_token: undefined }))?.refreshToken).toBeUndefined();
	});
});

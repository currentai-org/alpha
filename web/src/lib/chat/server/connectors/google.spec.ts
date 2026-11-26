// Connect Google. What has to hold: the consent asks for offline, read-only access; a grant
// short of either read-only scope or without a refresh token is refused; a turn gets the connector only
// for a signed-in person who connected, with a bearer that reaches the connector's origin and no other;
// the access token is refreshed only near expiry and never reused across a reconnect; and a failed
// refresh leaves Google out of the turn rather than failing it.
import { describe, expect, it, vi } from "vitest";
import * as oidc from "openid-client";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => true, ensureFlagsPolled: async () => {} }));
vi.mock("$lib/chat/server/db/userGoogleConnections", () => ({ getUserGoogleConnection: async () => null }));

const {
	accessTokenFor,
	finishConnect,
	GoogleConnectError,
	GOOGLE_SCOPES,
	googleServerFor,
	sealRefreshToken,
	startConnect,
} = await import("./google");
type Row = import("$lib/chat/server/db/userGoogleConnections").UserGoogleConnectionRow;

const SECRET = "a".repeat(64);
const app = {
	clientId: "client-1.apps.googleusercontent.com",
	clientSecret: "client-secret",
	redirectUri: "http://localhost:3000/chat/api/connectors/google/callback",
	connectorUrl: "http://google:8000/mcp",
};
const ISSUER = "https://accounts.google.com";
const READ_ONLY = GOOGLE_SCOPES.filter((s) => s.startsWith("https://"));

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function idToken(claims: Record<string, unknown>): string {
	const now = Math.floor(Date.now() / 1000);
	return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: ISSUER, aud: app.clientId, sub: "1", iat: now, exp: now + 600, ...claims })}.c2ln`;
}

/** Google's metadata offline, with the token endpoint answered by `token`. */
function offline(token: (body: URLSearchParams) => Record<string, unknown>) {
	const cfg = new oidc.Configuration(
		{
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`,
			token_endpoint: "https://oauth2.googleapis.com/token",
			jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
		},
		app.clientId,
		app.clientSecret
	);
	cfg[oidc.customFetch] = async (_url, init) =>
		new Response(JSON.stringify(token(new URLSearchParams(String(init.body)))), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return async () => cfg;
}

async function callbackFor(state: string): Promise<URL> {
	return new URL(`${app.redirectUri}?code=the-code&state=${state}&scope=${encodeURIComponent(READ_ONLY.join(" "))}`);
}

const locals = (id?: string) => ({ user: id ? { _id: { toString: () => id } } : undefined }) as App.Locals;
const row = (userId: string, credential = sealRefreshToken("refresh-1", SECRET)): Row => ({
	userId,
	email: "me@example.org",
	scopes: READ_ONLY.join(" "),
	credential,
	createdAt: new Date(),
});

describe("Connect Google consent", () => {
	it("asks Google for offline, read-only Gmail and Calendar access, with PKCE", async () => {
		const { url, state } = await startConnect(app, { discover: offline(() => ({})) });
		const q = url.searchParams;
		expect(q.get("access_type")).toBe("offline");
		expect(q.get("prompt")).toBe("consent");
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("state")).toBe(state);
		expect(q.get("redirect_uri")).toBe(app.redirectUri);
		const scopes = (q.get("scope") ?? "").split(" ");
		expect(scopes).toEqual(expect.arrayContaining(READ_ONLY));
		// Nothing that could send, change or delete.
		expect(scopes.filter((s) => s.startsWith("https://") && !s.endsWith(".readonly"))).toEqual([]);
	});

	it("keeps the refresh token, the email and the granted scopes from a full grant", async () => {
		const { state, verifier } = await startConnect(app, { discover: offline(() => ({})) });
		const discover = offline((body) => {
			expect(body.get("code_verifier")).toBe(verifier);
			return {
				access_token: "ya29.a",
				token_type: "Bearer",
				expires_in: 3599,
				refresh_token: "1//refresh",
				scope: ["openid", ...READ_ONLY].join(" "),
				id_token: idToken({ email: "me@example.org" }),
			};
		});
		const grant = await finishConnect(app, await callbackFor(state), { state, verifier }, { discover });
		expect(grant).toEqual({ refreshToken: "1//refresh", email: "me@example.org", scopes: ["openid", ...READ_ONLY].join(" ") });
	});

	it("refuses a grant where the person unticked Calendar on Google's screen (fail loud, nothing stored)", async () => {
		const { state, verifier } = await startConnect(app, { discover: offline(() => ({})) });
		const discover = offline(() => ({
			access_token: "ya29.a",
			token_type: "Bearer",
			refresh_token: "1//refresh",
			scope: ["openid", READ_ONLY.find((s) => s.includes("gmail"))].join(" "),
			id_token: idToken({ email: "me@example.org" }),
		}));
		await expect(finishConnect(app, await callbackFor(state), { state, verifier }, { discover })).rejects.toEqual(
			new GoogleConnectError("missing-scope")
		);
	});

	it("refuses a grant with no refresh token, which could not outlive the hour", async () => {
		const { state, verifier } = await startConnect(app, { discover: offline(() => ({})) });
		const discover = offline(() => ({
			access_token: "ya29.a",
			token_type: "Bearer",
			scope: READ_ONLY.join(" "),
			id_token: idToken({ email: "me@example.org" }),
		}));
		await expect(finishConnect(app, await callbackFor(state), { state, verifier }, { discover })).rejects.toEqual(
			new GoogleConnectError("no-refresh-token")
		);
	});

	it("refuses a callback whose state is not the one this connect minted", async () => {
		const { verifier } = await startConnect(app, { discover: offline(() => ({})) });
		const discover = offline(() => ({ access_token: "x", token_type: "Bearer" }));
		await expect(finishConnect(app, await callbackFor("forged"), { state: "minted", verifier }, { discover })).rejects.toThrow();
	});
});

describe("Google on a turn", () => {
	const refreshed = (token: string, expires_in = 3600) =>
		vi.fn(async () => ({ access_token: token, token_type: "bearer" as const, expires_in }) as oidc.TokenEndpointResponse);
	const base = { app, secret: SECRET, discover: offline(() => ({})) };

	it("gives a connected person the connector, carrying their access token as the bearer", async () => {
		const server = await googleServerFor(locals("u-connected"), { ...base, read: async () => row("u-connected"), refresh: refreshed("ya29.mine") });
		expect(server).toMatchObject({ name: "google", url: app.connectorUrl, origin: "http://google:8000" });
		expect(server?.headers).toEqual({ Authorization: "Bearer ya29.mine" });
	});

	it("never sends the bearer to another origin, even by a redirect", async () => {
		const seen: string[] = [];
		const baseFetch = vi.fn(async (url: string | URL) => {
			seen.push(String(url));
			return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } });
		});
		const server = await googleServerFor(locals("u-redirect"), {
			...base,
			read: async () => row("u-redirect"),
			refresh: refreshed("ya29.r"),
			baseFetch,
		});
		await expect(server!.fetch(app.connectorUrl, { method: "POST", headers: server!.headers })).rejects.toThrow();
		expect(seen).toEqual([app.connectorUrl]);
	});

	it("offers nothing to a guest or to a person who has not connected", async () => {
		const read = vi.fn(async () => null);
		expect(await googleServerFor(locals(), { ...base, read })).toBeNull();
		expect(read).not.toHaveBeenCalled();
		expect(await googleServerFor(locals("u-none"), { ...base, read })).toBeNull();
	});

	it("offers nothing while the flag is off, without reading the connection", async () => {
		const read = vi.fn(async () => row("u-off"));
		expect(await googleServerFor(locals("u-off"), { ...base, read, enabled: () => false })).toBeNull();
		expect(read).not.toHaveBeenCalled();
	});

	it("leaves Google out of the turn, not fails it, when Google refuses the refresh", async () => {
		const refresh = vi.fn(async () => {
			throw new Error("invalid_grant");
		});
		expect(await googleServerFor(locals("u-refused"), { ...base, read: async () => row("u-refused"), refresh })).toBeNull();
	});

	it("reuses an access token until two minutes before it expires, then refreshes", async () => {
		const r = row("u-cache");
		const refresh = refreshed("ya29.one", 3600);
		let now = 1_000_000;
		const deps = { ...base, refresh, now: () => now };
		expect(await accessTokenFor(app, r, deps)).toBe("ya29.one");
		now += 3600_000 - 121_000;
		expect(await accessTokenFor(app, r, deps)).toBe("ya29.one");
		expect(refresh).toHaveBeenCalledTimes(1);
		now += 2_000;
		await accessTokenFor(app, r, deps);
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	it("never reuses an access token across a reconnect, which seals a new refresh token", async () => {
		const refresh = vi.fn(async (_c: oidc.Configuration, t: string) => ({ access_token: `ya29.for-${t}`, token_type: "bearer" as const, expires_in: 3600 }) as oidc.TokenEndpointResponse);
		const deps = { ...base, refresh };
		expect(await accessTokenFor(app, row("u-re", sealRefreshToken("first", SECRET)), deps)).toBe("ya29.for-first");
		expect(await accessTokenFor(app, row("u-re", sealRefreshToken("second", SECRET)), deps)).toBe("ya29.for-second");
	});
});

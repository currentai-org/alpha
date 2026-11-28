// The `mcp_oauth_stub` stand-in (oauthE2eStub.ts), driven by the real MCP SDK. What has to hold: a
// sign-in runs discovery, registration and PKCE to a consent URL on the stand-in's host; the code the
// spec answers with trades for tokens only with the matching verifier; the access token lists the tool
// through the real MCP client; the refresh token refreshes to new tokens; once the person signed the app
// out at the provider, both tokens are refused; and with short-lived access tokens, an old one is
// refused while the refresh token still refreshes. The scenario mcp-oauth-connect.spec.ts drives the same path
// from a browser.
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => false, ensureFlagsPolled: async () => {} }));

const { auth } = await import("@modelcontextprotocol/client");
const { RowOAuthProvider } = await import("./oauthProvider");
const { MCP_OAUTH_STUB_ORIGIN, MCP_OAUTH_STUB_URL, mcpOAuthFetchFor, mcpOAuthStubFetch, mcpOAuthStubToolDescription } =
	await import("./oauthE2eStub");
const { ssrfStrictFetch } = await import("$lib/chat/server/urlSafety");
const { connectMcp } = await import("./client");
type State = import("./oauthProvider").McpOAuthState;

const REDIRECT = "http://localhost:4173/chat/api/connectors/mcp/callback";
const live = mcpOAuthStubFetch({ signedOut: false });
const signedOut = mcpOAuthStubFetch({ signedOut: true });

function provider(state: State, stateParam?: string) {
	const box = { state };
	const p = new RowOAuthProvider({
		state,
		redirectUrl: REDIRECT,
		...(stateParam ? { stateParam } : {}),
		persist: async (s) => {
			box.state = s;
		},
	});
	return { p, box };
}

/** A sign-in up to tokens, answering the consent screen the way the scenario does. */
async function signIn(fetchFn = live): Promise<State> {
	const start = provider({}, "state-1");
	expect(await auth(start.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn })).toBe("REDIRECT");
	const consent = start.p.authorizationUrl!;
	const finish = provider(start.box.state);
	const code = consent.searchParams.get("code_challenge")!;
	expect(await auth(finish.p, { serverUrl: MCP_OAUTH_STUB_URL, authorizationCode: code, fetchFn })).toBe("AUTHORIZED");
	return finish.box.state;
}

/** One tools/list at the stand-in's MCP server with this access token. */
const listWith = (fetchFn: typeof live, accessToken: string) =>
	fetchFn(MCP_OAUTH_STUB_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
		body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
	});

describe("the OAuth MCP stand-in, through the real SDK", () => {
	it("sends a sign-in to a PKCE consent URL on the stand-in's host, bound to our state and redirect", async () => {
		const start = provider({}, "state-1");
		expect(await auth(start.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: live })).toBe("REDIRECT");
		const consent = start.p.authorizationUrl!;
		expect(consent.origin).toBe(MCP_OAUTH_STUB_ORIGIN);
		expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
		expect(consent.searchParams.get("state")).toBe("state-1");
		expect(consent.searchParams.get("redirect_uri")).toBe(REDIRECT);
		expect(start.box.state.client?.client_id).toBeTruthy();
		expect(start.box.state.verifier).toBeTruthy();
	});

	it("trades the code for tokens, and the access token lists the tool through the MCP client", async () => {
		const state = await signIn();
		expect(state.tokens?.refresh_token).toBeTruthy();
		expect(state.verifier).toBeUndefined();
		const conn = await connectMcp(MCP_OAUTH_STUB_URL, {
			headers: { Authorization: `Bearer ${state.tokens!.access_token}` },
			fetch: live,
		});
		expect(conn.tools.map((t) => t.name)).toEqual(["read_note"]);
		const signedInAt = Number(state.tokens!.access_token.split(".").pop());
		expect(conn.tools[0].description).toBe(mcpOAuthStubToolDescription(signedInAt));
		await conn.close();
	});

	it("refuses an access token it did not issue", async () => {
		expect((await listWith(live, "e2e-mcp-oauth-access")).status).toBe(401);
		expect((await listWith(live, "e2e-mcp-oauth-refresh.1")).status).toBe(401);
	});

	it("refuses a code sent with another verifier", async () => {
		const start = provider({}, "state-1");
		await auth(start.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: live });
		const finish = provider({ ...start.box.state, verifier: "not-the-verifier-the-challenge-was-made-from" });
		const code = start.p.authorizationUrl!.searchParams.get("code_challenge")!;
		await expect(auth(finish.p, { serverUrl: MCP_OAUTH_STUB_URL, authorizationCode: code, fetchFn: live })).rejects.toThrow();
	});

	it("refreshes with the refresh token to new tokens", async () => {
		let t = 1_000;
		const clocked = mcpOAuthStubFetch({ signedOut: false, now: () => t });
		const state = await signIn(clocked);
		t = 2_000;
		const again = provider({ ...state, tokens: { ...state.tokens!, access_token: "stale" } });
		expect(await auth(again.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: clocked })).toBe("AUTHORIZED");
		expect(again.box.state.tokens?.access_token).toBe("e2e-mcp-oauth-access.2000");
		expect(again.box.state.tokens?.refresh_token).toBe("e2e-mcp-oauth-refresh.2000");
	});

	it("with short-lived access tokens, answers 401 to an old one and still honours the refresh token", async () => {
		let t = 1_000;
		const expiring = mcpOAuthStubFetch({ signedOut: false, accessLifetimeMs: 5_000, now: () => t });
		const state = await signIn(expiring);
		t = 6_000;
		expect((await listWith(expiring, state.tokens!.access_token)).status).toBe(200);
		t = 6_001;
		expect((await listWith(expiring, state.tokens!.access_token)).status).toBe(401);
		const again = provider(state);
		expect(await auth(again.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: expiring })).toBe("AUTHORIZED");
		const fresh = again.box.state.tokens!.access_token;
		expect(fresh).toBe("e2e-mcp-oauth-access.6001");
		expect((await listWith(expiring, fresh)).status).toBe(200);
	});

	it("once signed out at the provider, refuses the access token and the refresh token", async () => {
		const state = await signIn();
		const res = await listWith(signedOut, state.tokens!.access_token);
		expect(res.status).toBe(401);
		const again = provider(state);
		await expect(
			auth(again.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: signedOut }).then((r) => {
				if (r !== "AUTHORIZED") throw new Error(r);
			})
		).rejects.toThrow();
	});
});

describe("mcpOAuthFetchFor: only the stand-in's faults arm it", () => {
	it("is the strict SSRF guard itself with no fault, or any other fault", () => {
		expect(mcpOAuthFetchFor(null)).toBe(ssrfStrictFetch);
		expect(mcpOAuthFetchFor(undefined)).toBe(ssrfStrictFetch);
		expect(mcpOAuthFetchFor("google_connector_stub")).toBe(ssrfStrictFetch);
	});

	it("answers the stand-in's host in-process under its fault, signed in or signed out", async () => {
		const meta = await mcpOAuthFetchFor("mcp_oauth_stub")(`${MCP_OAUTH_STUB_ORIGIN}/.well-known/oauth-protected-resource/mcp`);
		expect(((await meta.json()) as { resource: string }).resource).toBe(MCP_OAUTH_STUB_URL);
		const mcp = await mcpOAuthFetchFor("mcp_oauth_stub_signed_out")(MCP_OAUTH_STUB_URL, { method: "POST", body: "{}" });
		expect(mcp.status).toBe(401);
		const expiring = await mcpOAuthFetchFor("mcp_oauth_stub_expiring")(MCP_OAUTH_STUB_URL, { method: "POST", body: "{}" });
		expect(expiring.status).toBe(401);
	});

	it("still sends any other host through the guard under the fault, which refuses a loopback address", async () => {
		await expect(mcpOAuthFetchFor("mcp_oauth_stub")("http://127.0.0.1:9/mcp")).rejects.toThrow();
	});
});

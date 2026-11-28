// The `mcp_oauth_stub` stand-in (oauthE2eStub.ts), driven by the real MCP SDK. What has to hold: a
// sign-in runs discovery, registration and PKCE to a consent URL on the stand-in's host; the code the
// spec answers with trades for tokens only with the matching verifier; the access token lists the tool
// through the real MCP client; the refresh token refreshes; and once the person signed the app out at
// the provider, both tokens are refused. The scenario mcp-oauth-connect.spec.ts drives the same path
// from a browser.
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: () => false, ensureFlagsPolled: async () => {} }));

const { auth } = await import("@modelcontextprotocol/client");
const { RowOAuthProvider } = await import("./oauthProvider");
const { MCP_OAUTH_STUB_ORIGIN, MCP_OAUTH_STUB_URL, mcpOAuthFetchFor, mcpOAuthStubFetch } = await import("./oauthE2eStub");
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
async function signIn(): Promise<State> {
	const start = provider({}, "state-1");
	expect(await auth(start.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: live })).toBe("REDIRECT");
	const consent = start.p.authorizationUrl!;
	const finish = provider(start.box.state);
	const code = consent.searchParams.get("code_challenge")!;
	expect(await auth(finish.p, { serverUrl: MCP_OAUTH_STUB_URL, authorizationCode: code, fetchFn: live })).toBe("AUTHORIZED");
	return finish.box.state;
}

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
		await conn.close();
	});

	it("refuses a code sent with another verifier", async () => {
		const start = provider({}, "state-1");
		await auth(start.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: live });
		const finish = provider({ ...start.box.state, verifier: "not-the-verifier-the-challenge-was-made-from" });
		const code = start.p.authorizationUrl!.searchParams.get("code_challenge")!;
		await expect(auth(finish.p, { serverUrl: MCP_OAUTH_STUB_URL, authorizationCode: code, fetchFn: live })).rejects.toThrow();
	});

	it("refreshes with the refresh token", async () => {
		const state = await signIn();
		const again = provider({ ...state, tokens: { ...state.tokens!, access_token: "stale" } });
		expect(await auth(again.p, { serverUrl: MCP_OAUTH_STUB_URL, fetchFn: live })).toBe("AUTHORIZED");
		expect(again.box.state.tokens?.access_token).toBe(state.tokens!.access_token);
	});

	it("once signed out at the provider, refuses the access token and the refresh token", async () => {
		const state = await signIn();
		const res = await signedOut(MCP_OAUTH_STUB_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${state.tokens!.access_token}`, "content-type": "application/json" },
			body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
		});
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
	});

	it("still sends any other host through the guard under the fault, which refuses a loopback address", async () => {
		await expect(mcpOAuthFetchFor("mcp_oauth_stub")("http://127.0.0.1:9/mcp")).rejects.toThrow();
	});
});

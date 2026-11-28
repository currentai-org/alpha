// A stand-in for a person's own MCP server that signs them in with OAuth, for the `mcp_oauth_stub`
// faults. The MCP server and its authorization server are answered inside this process, on a host that
// never resolves: an end-to-end spec cannot sign in to a real provider, and a server on the runner would
// need the SSRF guard to let a loopback address through. Everything between them is the real code: the
// MCP SDK's discovery, dynamic client registration, PKCE, code exchange and refresh, the sealed state on
// the row, and the MCP client listing tools with the access token as its bearer.
//
// The stand-in keeps no state, so every process answers a request the same way: the authorization
// code is the PKCE challenge itself (the spec answers the consent screen with it), and the token
// endpoint checks it against the verifier the SDK sends.
//
// `mcp_oauth_stub_signed_out` is the same provider after the person took the app off their account
// there: it refuses the access token at the MCP server and the refresh token at the token endpoint.
import { createHash } from "node:crypto";
import { fixtureFetch, type McpFixture } from "./e2eStub";
import type { FetchLike } from "./servers";

export const MCP_OAUTH_STUB_ORIGIN = "https://mcp-oauth.e2e.invalid";
/** The server URL a spec adds in Settings → Connectors. */
export const MCP_OAUTH_STUB_URL = `${MCP_OAUTH_STUB_ORIGIN}/mcp`;
const AUTHORIZATION_ENDPOINT = `${MCP_OAUTH_STUB_ORIGIN}/authorize`;
const TOKEN_ENDPOINT = `${MCP_OAUTH_STUB_ORIGIN}/token`;
const REGISTRATION_ENDPOINT = `${MCP_OAUTH_STUB_ORIGIN}/register`;
const CLIENT_ID = "e2e-mcp-oauth-client";
const ACCESS_TOKEN = "e2e-mcp-oauth-access";
const REFRESH_TOKEN = "e2e-mcp-oauth-refresh";
/** The fact only the stand-in's tool returns. */
export const MCP_OAUTH_STUB_FACT = "the shed key is under the blue pot";

const FIXTURE: McpFixture = {
	serverName: "mcp-oauth-e2e-stub",
	tools: [
		{
			name: "read_note",
			description: "Read one of the person's notes, by its title.",
			inputSchema: {
				type: "object",
				properties: { title: { type: "string", description: "The note's title" } },
				required: ["title"],
			},
			annotations: { readOnlyHint: true },
		},
	],
	call: (tool) =>
		tool === "read_note"
			? { content: [{ type: "text", text: `Note: ${MCP_OAUTH_STUB_FACT}.` }] }
			: { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true },
};
const answerMcp = fixtureFetch(FIXTURE);

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

async function bodyText(init: RequestInit | undefined): Promise<string> {
	const body = init?.body;
	if (body === undefined || body === null) return "";
	if (typeof body === "string") return body;
	if (body instanceof URLSearchParams) return body.toString();
	return new Response(body as BodyInit).text();
}

/**
 * The MCP server and its authorization server, answered in-process. `signedOut`: the person took the
 * app off their account at the provider, so neither token works any more.
 */
export function mcpOAuthStubFetch(opts: { signedOut: boolean }): FetchLike {
	return async (input, init) => {
		const url = new URL(String(input));
		if (url.origin !== MCP_OAUTH_STUB_ORIGIN) return json(404, { error: "not_found" });
		const path = url.pathname;
		if (path.startsWith("/.well-known/oauth-protected-resource")) {
			return json(200, { resource: MCP_OAUTH_STUB_URL, authorization_servers: [MCP_OAUTH_STUB_ORIGIN] });
		}
		if (path.startsWith("/.well-known/oauth-authorization-server") || path.startsWith("/.well-known/openid-configuration")) {
			return json(200, {
				issuer: MCP_OAUTH_STUB_ORIGIN,
				authorization_endpoint: AUTHORIZATION_ENDPOINT,
				token_endpoint: TOKEN_ENDPOINT,
				registration_endpoint: REGISTRATION_ENDPOINT,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (path === "/register") {
			const metadata = JSON.parse((await bodyText(init)) || "{}") as Record<string, unknown>;
			return json(201, { ...metadata, client_id: CLIENT_ID, client_id_issued_at: Math.floor(Date.now() / 1000) });
		}
		if (path === "/token") {
			const form = new URLSearchParams(await bodyText(init));
			const grant = form.get("grant_type");
			if (grant === "authorization_code") {
				const code = form.get("code");
				const verifier = form.get("code_verifier");
				if (!code || !verifier || s256(verifier) !== code || form.get("client_id") !== CLIENT_ID) {
					return json(400, { error: "invalid_grant" });
				}
				return json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH_TOKEN });
			}
			if (grant === "refresh_token" && !opts.signedOut && form.get("refresh_token") === REFRESH_TOKEN) {
				return json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600, refresh_token: REFRESH_TOKEN });
			}
			return json(400, { error: "invalid_grant" });
		}
		if (path === "/mcp") {
			const bearer = new Headers(init?.headers).get("authorization");
			if (opts.signedOut || bearer !== `Bearer ${ACCESS_TOKEN}`) return new Response(null, { status: 401 });
			return answerMcp(url, init);
		}
		return json(404, { error: "not_found" });
	};
}

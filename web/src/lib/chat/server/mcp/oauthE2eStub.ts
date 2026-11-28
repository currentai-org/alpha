// A stand-in for a person's own MCP server that signs them in with OAuth, for the `mcp_oauth_stub`
// faults. The MCP server and its authorization server are answered inside this process, on a host that
// never resolves: an end-to-end spec cannot sign in to a real provider, and a server on the runner would
// need the SSRF guard to let a loopback address through. Everything between them is the real code: the
// MCP SDK's discovery, dynamic client registration, PKCE, code exchange and refresh, the sealed state on
// the row, and the MCP client listing tools with the access token as its bearer.
//
// The stand-in keeps no state, so every process answers a request the same way: the authorization
// code is the PKCE challenge itself (the spec answers the consent screen with it), and the token
// endpoint checks it against the verifier the SDK sends. Each token carries the time it was issued,
// and the tool's description names the time of the access token the server was reached with, so a spec
// can see which sign-in the app sent.
//
// `mcp_oauth_stub_signed_out` is the same provider after the person took the app off their account
// there: it refuses the access token at the MCP server and the refresh token at the token endpoint.
//
// `mcp_oauth_stub_expiring` is the same provider with short-lived access tokens: the MCP server answers
// 401 to an access token issued more than five seconds ago, and the refresh token still refreshes.
import { createHash } from "node:crypto";
import { ssrfStrictFetch } from "$lib/chat/server/urlSafety";
import type { FaultInjectionName } from "$lib/chat/server/textGeneration/faultInjection";
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
/** How long an access token lasts under `mcp_oauth_stub_expiring`. */
export const MCP_OAUTH_STUB_EXPIRING_MS = 5_000;
/** The fact only the stand-in's tool returns. */
export const MCP_OAUTH_STUB_FACT = "the shed key is under the blue pot";

/** A token of `kind` issued now: `<kind>.<issued at, in ms>`. */
const issue = (kind: string, now: number) => `${kind}.${now}`;

/** When a token of `kind` was issued, or null for anything the stand-in did not issue. */
function issuedAt(kind: string, token: string | null | undefined): number | null {
	const m = token?.match(/^([\w-]+)\.(\d+)$/);
	return m && m[1] === kind ? Number(m[2]) : null;
}

function tokens(now: number) {
	return {
		access_token: issue(ACCESS_TOKEN, now),
		token_type: "Bearer",
		expires_in: 3600,
		refresh_token: issue(REFRESH_TOKEN, now),
	};
}

/** The tool's description, naming when the access token the server was reached with was issued. */
export const mcpOAuthStubToolDescription = (signedInAt: number) =>
	`Read one of the person's notes, by its title. Signed in at ${signedInAt}.`;

const fixtureFor = (signedInAt: number): McpFixture => ({
	serverName: "mcp-oauth-e2e-stub",
	tools: [
		{
			name: "read_note",
			description: mcpOAuthStubToolDescription(signedInAt),
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
});

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
 * app off their account at the provider, so neither token works any more. `accessLifetimeMs`: the MCP
 * server refuses an access token issued longer ago than this; with none, an access token never expires.
 */
export function mcpOAuthStubFetch(opts: { signedOut: boolean; accessLifetimeMs?: number; now?: () => number }): FetchLike {
	const now = opts.now ?? Date.now;
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
				return json(200, tokens(now()));
			}
			if (grant === "refresh_token" && !opts.signedOut && issuedAt(REFRESH_TOKEN, form.get("refresh_token")) !== null) {
				return json(200, tokens(now()));
			}
			return json(400, { error: "invalid_grant" });
		}
		if (path === "/mcp") {
			const bearer = new Headers(init?.headers).get("authorization");
			const signedInAt = bearer?.startsWith("Bearer ") ? issuedAt(ACCESS_TOKEN, bearer.slice(7)) : null;
			if (opts.signedOut || signedInAt === null) return new Response(null, { status: 401 });
			if (opts.accessLifetimeMs !== undefined && now() - signedInAt > opts.accessLifetimeMs) {
				return new Response(null, { status: 401 });
			}
			return fixtureFetch(fixtureFor(signedInAt))(url, init);
		}
		return json(404, { error: "not_found" });
	};
}

/** The faults that answer the stand-in's host in-process. */
export function isMcpOAuthStubFault(faultInjection: FaultInjectionName | null | undefined): boolean {
	return (
		faultInjection === "mcp_oauth_stub" ||
		faultInjection === "mcp_oauth_stub_signed_out" ||
		faultInjection === "mcp_oauth_stub_expiring"
	);
}

/**
 * The fetch a person's OAuth server is reached and signed in through. With no stand-in fault it is the
 * strict SSRF guard itself. Under one, the stand-in's host is answered in-process and every other host
 * still goes through the guard. The fault arrives here only after faultInjection.ts's gate passed.
 */
export function mcpOAuthFetchFor(faultInjection: FaultInjectionName | null | undefined): FetchLike {
	if (!isMcpOAuthStubFault(faultInjection)) return ssrfStrictFetch;
	const stub = mcpOAuthStubFetch({
		signedOut: faultInjection === "mcp_oauth_stub_signed_out",
		...(faultInjection === "mcp_oauth_stub_expiring" ? { accessLifetimeMs: MCP_OAUTH_STUB_EXPIRING_MS } : {}),
	});
	return (input, init) =>
		new URL(String(input)).origin === MCP_OAUTH_STUB_ORIGIN ? stub(input, init) : ssrfStrictFetch(input, init);
}

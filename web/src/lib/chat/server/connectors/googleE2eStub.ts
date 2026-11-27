// Stand-ins for Google and the Google connector, for the `google_connector_stub` fault. Both are
// answered inside this process: an end-to-end spec cannot sign in to a real Google account, and the
// connector it would reach needs one. Everything between them is the real code: openid-client builds
// the consent URL, checks the state and PKCE verifier and the ID token on the code exchange, and runs the
// refresh; the refresh token is sealed and stored; the MCP SDK client lists and calls the tools through
// the origin-scoped fetch with the access token as its bearer.
//
// The fault only arms where every fault does (faultInjection.ts `carriesFaultInjectToken`): a preview
// or development deployment, on a request carrying the HMAC fault token. Production and a self-hosted
// install without the token never reach this file.
import * as oidc from "openid-client";
import { fixtureFetch, type McpFixture } from "$lib/chat/server/mcp/e2eStub";
import type { FetchLike } from "$lib/chat/server/mcp/servers";

/** Google's consent screen, stood in for on a host that never resolves: the spec answers it itself. */
const STUB_GOOGLE_ISSUER = "https://accounts-google.e2e.invalid";
const STUB_GOOGLE_AUTHORIZATION_ENDPOINT = `${STUB_GOOGLE_ISSUER}/o/oauth2/v2/auth`;
/** Never fetched over the network: the configuration's customFetch answers it. */
const STUB_GOOGLE_TOKEN_ENDPOINT = "https://oauth2-google.e2e.invalid/exchange";
/** The account the stand-in's ID token names, which Settings → Connectors shows as connected. */
const STUB_GOOGLE_EMAIL = "drive-e2e@example.org";
const STUB_REFRESH_TOKEN = "1//e2e-google-refresh";
/** The only bearer the stand-in connector accepts: the one the stand-in's refresh hands out. */
const STUB_ACCESS_TOKEN = "ya29.e2e-google-access";
/** The fact only the Drive search returns, which the spec looks for in the answer. */
const STUB_DRIVE_FACT = "Allotment rota: plot 7 waters on Thursdays";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

/** An ID token shaped as Google's. openid-client checks its claims on the code exchange; it does not
 *  check the signature of a token it received over TLS from the token endpoint, so none is made. */
function idToken(clientId: string): string {
	const now = Math.floor(Date.now() / 1000);
	const claims = {
		iss: STUB_GOOGLE_ISSUER,
		aud: clientId,
		sub: "e2e-google-account",
		iat: now,
		exp: now + 600,
		email: STUB_GOOGLE_EMAIL,
		email_verified: true,
	};
	return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2ln`;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * Google's OIDC configuration, built offline, with its token endpoint answered in-process. A code
 * exchange gets a refresh token, every scope in `scopes`, and an ID token naming STUB_GOOGLE_EMAIL.
 * A refresh of that token gets the one access token the stand-in connector takes.
 */
export function stubGoogleOidc(scopes: readonly string[]) {
	return async (app: { clientId: string; clientSecret: string }): Promise<oidc.Configuration> => {
		const cfg = new oidc.Configuration(
			{
				issuer: STUB_GOOGLE_ISSUER,
				authorization_endpoint: STUB_GOOGLE_AUTHORIZATION_ENDPOINT,
				token_endpoint: STUB_GOOGLE_TOKEN_ENDPOINT,
				jwks_uri: `${STUB_GOOGLE_ISSUER}/certs`,
			},
			app.clientId,
			app.clientSecret
		);
		cfg[oidc.customFetch] = async (url, init) => {
			if (url !== STUB_GOOGLE_TOKEN_ENDPOINT) return json(404, { error: "not_found" });
			const body = new URLSearchParams(String(init.body));
			const grant = body.get("grant_type");
			if (grant === "authorization_code" && body.get("code") && body.get("code_verifier")) {
				return json(200, {
					access_token: STUB_ACCESS_TOKEN,
					token_type: "Bearer",
					expires_in: 3599,
					refresh_token: STUB_REFRESH_TOKEN,
					scope: scopes.join(" "),
					id_token: idToken(app.clientId),
				});
			}
			if (grant === "refresh_token" && body.get("refresh_token") === STUB_REFRESH_TOKEN) {
				return json(200, { access_token: STUB_ACCESS_TOKEN, token_type: "Bearer", expires_in: 3599 });
			}
			return json(400, { error: "invalid_grant" });
		};
		return cfg;
	};
}

const DRIVE_FILE_ID = "e2e-allotment-rota";

const GOOGLE_STUB_FIXTURE: McpFixture = {
	serverName: "google-workspace-e2e-stub",
	tools: [
		{
			name: "search_drive_files",
			description:
				"Search the person's Google Drive for files matching a query, and return each match's name, id and a snippet.",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string", description: "What to search for" } },
				required: ["query"],
			},
			annotations: { readOnlyHint: true },
		},
		{
			name: "get_drive_file_content",
			description: "Read the text of one Google Drive file, by its id.",
			inputSchema: {
				type: "object",
				properties: { file_id: { type: "string", description: "The file's id" } },
				required: ["file_id"],
			},
			annotations: { readOnlyHint: true },
		},
	],
	call: (tool, args) => {
		if (tool === "search_drive_files") {
			const query = typeof args.query === "string" ? args.query : "";
			const text = `Found 1 file for "${query}":\n- Allotment rota (Google Doc, id: ${DRIVE_FILE_ID})\n  Snippet: ${STUB_DRIVE_FACT}.`;
			return { content: [{ type: "text", text }] };
		}
		if (tool === "get_drive_file_content") {
			return { content: [{ type: "text", text: `${STUB_DRIVE_FACT}. Plot 3 waters on Mondays.` }] };
		}
		return { content: [{ type: "text", text: `unknown tool ${tool}` }], isError: true };
	},
};

const answerGoogleStub = fixtureFetch(GOOGLE_STUB_FIXTURE);

/** The connector, answered in-process. It answers 401 to any bearer but the stand-in's refreshed
 *  access token, so a listed tool shows the refresh ran and its result reached the connector. */
export const stubGoogleMcpFetch: FetchLike = async (url, init) => {
	if (new Headers(init?.headers).get("authorization") !== `Bearer ${STUB_ACCESS_TOKEN}`) {
		return new Response(null, { status: 401 });
	}
	return answerGoogleStub(url, init);
};

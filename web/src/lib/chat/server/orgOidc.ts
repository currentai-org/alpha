// an organisation that runs its own Alpha lets its people sign in with the login it already
// has (Keycloak, Authentik, Cognito, Entra, any OpenID Connect provider), set from env alone.
//
// Our names are OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_PROVIDER_NAME and OIDC_SCOPES.
// The names an Open WebUI install already uses are read as aliases, so an operator moving over keeps
// their env: OPENID_PROVIDER_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_PROVIDER_NAME and
// OAUTH_SCOPES. Ours win field by field.
//
// OPENID_PROVIDER_URL is also the Hugging Face provider's variable here (oidcConfig.ts), and our own
// deployments set it for that. So it counts as this provider's issuer only beside Open WebUI's
// OAUTH_CLIENT_ID. Nothing of ours sets that one.
//
// The provider registers through genericOAuth with a discoveryUrl. Better Auth (1.7.10+) fetches it at
// startup and, when the fetch fails, logs the provider by id and skips it, so an unreachable issuer
// costs only its own button and never the other sign-in methods. ID tokens are verified
// against the issuer's JWKS, and a discovery document without one skips the provider too.
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

export const ORG_OIDC_PROVIDER_ID = "org-oidc";
const DEFAULT_NAME = "SSO";
const DEFAULT_SCOPES = "openid email profile";
const WELL_KNOWN = "/.well-known/openid-configuration";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Every variable this provider reads, ours first, then Open WebUI's. */
export const ORG_OIDC_ENV_KEYS = [
	"OIDC_ISSUER",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_PROVIDER_NAME",
	"OIDC_SCOPES",
	"OPENID_PROVIDER_URL",
	"OAUTH_CLIENT_ID",
	"OAUTH_CLIENT_SECRET",
	"OAUTH_PROVIDER_NAME",
	"OAUTH_SCOPES",
] as const;

type Env = Partial<Record<string, string | undefined>>;

export type OrgOidcDecision =
	| { register: true; config: GenericOAuthConfig; name: string; names: "alpha" | "open-webui" }
	| { register: false; reason: "unset" }
	| { register: false; reason: "incomplete" | "insecure-issuer" | "bad-issuer"; detail: string };

const read = (env: Env, key: string) => (env[key] ?? "").trim() || undefined;

/**
 * The discovery document's URL. Open WebUI's OPENID_PROVIDER_URL is the document's own URL, where an
 * issuer is the bare origin and path, so both are taken: a URL already ending in the well-known path
 * is used as given, and anything else gets it appended.
 */
function discoveryUrlOf(issuer: string): URL {
	const url = new URL(issuer);
	if (!url.pathname.endsWith(WELL_KNOWN)) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}${WELL_KNOWN}`;
	}
	return url;
}

/** Read the organisation's sign-in provider from env, or say why there is none. */
export function orgOidcProvider(env: Env): OrgOidcDecision {
	const owuiClient = read(env, "OAUTH_CLIENT_ID");
	const issuer = read(env, "OIDC_ISSUER") ?? (owuiClient ? read(env, "OPENID_PROVIDER_URL") : undefined);
	const clientId = read(env, "OIDC_CLIENT_ID") ?? owuiClient;
	const clientSecret = read(env, "OIDC_CLIENT_SECRET") ?? read(env, "OAUTH_CLIENT_SECRET");
	if (!issuer && !clientId && !clientSecret && !read(env, "OIDC_PROVIDER_NAME")) {
		return { register: false, reason: "unset" };
	}
	const missing = [
		!issuer && "OIDC_ISSUER (or OPENID_PROVIDER_URL)",
		!clientId && "OIDC_CLIENT_ID (or OAUTH_CLIENT_ID)",
		!clientSecret && "OIDC_CLIENT_SECRET (or OAUTH_CLIENT_SECRET)",
	].filter(Boolean);
	if (!issuer || !clientId || !clientSecret) {
		return { register: false, reason: "incomplete", detail: `missing ${missing.join(", ")}` };
	}

	let discovery: URL;
	try {
		discovery = discoveryUrlOf(issuer);
	} catch {
		return { register: false, reason: "bad-issuer", detail: `not a URL: ${issuer}` };
	}
	// Plain http only on this machine, where the test run's own mock provider sits.
	if (discovery.protocol !== "https:" && !(discovery.protocol === "http:" && LOOPBACK_HOSTS.has(discovery.hostname))) {
		return { register: false, reason: "insecure-issuer", detail: `${discovery.origin} is not https` };
	}

	const name = read(env, "OIDC_PROVIDER_NAME") ?? read(env, "OAUTH_PROVIDER_NAME") ?? DEFAULT_NAME;
	const scopes = (read(env, "OIDC_SCOPES") ?? read(env, "OAUTH_SCOPES") ?? DEFAULT_SCOPES).split(/[\s,]+/).filter(Boolean);
	return {
		register: true,
		name,
		names: read(env, "OIDC_ISSUER") || read(env, "OIDC_CLIENT_ID") ? "alpha" : "open-webui",
		config: {
			providerId: ORG_OIDC_PROVIDER_ID,
			name,
			clientId,
			clientSecret,
			discoveryUrl: discovery.toString(),
			requireIdTokenVerification: true,
			scopes,
			pkce: true,
		},
	};
}

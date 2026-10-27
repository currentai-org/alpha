// A stand-in OpenID Connect provider (`mock-oidc/`) so CI can walk our own genericOAuth
// code, from callback through state and PKCE checks and linking by verified email to session
// creation, without a real Hugging Face account. It registers BESIDE the Hugging Face provider under
// its own id and its own MOCK_OIDC_* vars, never in HF's place.
//
// Three properties this has to hold, each covered in mockOidc.spec.ts:
//
// REFUSED ON PRODUCTION. On production it is refused even with every var set, and says so loudly,
// because a mock identity provider on production is a sign-in anyone can complete.
//
// LOOPBACK ONLY. The mock runs inside the test run, beside the app on the same machine (CUR-2451,
// sign-in-local.yml). A mock on a public host lets anyone who finds it sign in to the deployment
// that trusts it (CUR-2522). So the app registers it only at a loopback address, and only on a
// preview or development server.
//
// CANNOT TAKE THE OTHER PROVIDERS DOWN, NOR DEPEND ON THE NETWORK AT STARTUP. The endpoints are given
// explicitly and there is no discoveryUrl, so init makes no network call and an unreachable mock
// fails only its own sign-in, at request time. With a discoveryUrl, Better Auth (1.7.10+) logs a
// failed discovery fetch and skips that one provider, but a skipped mock would still leave the CI
// sign-in walk with nothing to click.
//
// The ID token is then decoded without signature verification, which OIDC Core §3.1.3.7 allows for
// a token received directly from the token endpoint over TLS in exchange for our client secret. (CUR-1551)
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";

const MOCK_OIDC_PROVIDER_ID = "mock-oidc";

export type MockOidcEnv = {
	deployEnv: string | null;
	url?: string;
	clientId?: string;
	clientSecret?: string;
};

export type MockOidcDecision =
	| { register: true; config: GenericOAuthConfig }
	| { register: false; reason: "unset" | "unknown-env" | "not-loopback" | "production" };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopback(url: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

export function mockOidcProvider(env: MockOidcEnv): MockOidcDecision {
	const url = env.url?.trim().replace(/\/+$/, "");
	const anySet = Boolean(url || env.clientId || env.clientSecret);
	if (env.deployEnv === "production") return { register: false, reason: anySet ? "production" : "unset" };
	if (!url || !env.clientId || !env.clientSecret) return { register: false, reason: "unset" };
	if (env.deployEnv !== "preview" && env.deployEnv !== "development") {
		return { register: false, reason: "unknown-env" };
	}
	if (!isLoopback(url)) return { register: false, reason: "not-loopback" };
	return {
		register: true,
		config: {
			providerId: MOCK_OIDC_PROVIDER_ID,
			clientId: env.clientId,
			clientSecret: env.clientSecret,
			authorizationUrl: `${url}/authorize`,
			tokenUrl: `${url}/token`,
			userInfoUrl: `${url}/userinfo`,
			scopes: ["openid", "email", "profile"],
			pkce: true,
		},
	};
}

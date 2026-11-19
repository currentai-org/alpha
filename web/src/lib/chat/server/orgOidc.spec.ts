import { afterEach, describe, expect, it, vi } from "vitest";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { orgOidcProvider } from "./orgOidc";

const ORG_OIDC_PROVIDER_ID = "org-oidc";

const OURS = {
	OIDC_ISSUER: "https://login.example.org/realms/staff",
	OIDC_CLIENT_ID: "alpha",
	OIDC_CLIENT_SECRET: "s3cret",
	OIDC_PROVIDER_NAME: "Example Org",
};
const OPEN_WEBUI = {
	OPENID_PROVIDER_URL: "https://login.example.org/realms/staff/.well-known/openid-configuration",
	OAUTH_CLIENT_ID: "owui",
	OAUTH_CLIENT_SECRET: "owui-secret",
	OAUTH_PROVIDER_NAME: "Example Org SSO",
};

function registered(env: Record<string, string>) {
	const d = orgOidcProvider(env);
	if (!d.register) throw new Error(`expected a provider, got ${JSON.stringify(d)}`);
	return d;
}

describe("orgOidcProvider: the organisation's own sign-in, read from env", () => {
	it("registers from our names, discovering the issuer's well-known document with verified ID tokens", () => {
		const d = registered(OURS);
		expect(d.name).toBe("Example Org");
		expect(d.names).toBe("alpha");
		expect(d.config).toMatchObject({
			providerId: ORG_OIDC_PROVIDER_ID,
			name: "Example Org",
			clientId: "alpha",
			clientSecret: "s3cret",
			discoveryUrl: "https://login.example.org/realms/staff/.well-known/openid-configuration",
			requireIdTokenVerification: true,
			pkce: true,
			scopes: ["openid", "email", "profile"],
		});
	});

	it("registers from Open WebUI's names alone, taking OPENID_PROVIDER_URL as the discovery document it already is", () => {
		const d = registered(OPEN_WEBUI);
		expect(d.names).toBe("open-webui");
		expect(d.name).toBe("Example Org SSO");
		expect(d.config.clientId).toBe("owui");
		expect(d.config.clientSecret).toBe("owui-secret");
		expect(d.config.discoveryUrl).toBe(OPEN_WEBUI.OPENID_PROVIDER_URL);
	});

	it("prefers our names field by field when both are set", () => {
		const d = registered({ ...OPEN_WEBUI, OIDC_CLIENT_ID: "alpha", OIDC_PROVIDER_NAME: "Ours" });
		expect(d.config.clientId).toBe("alpha");
		expect(d.name).toBe("Ours");
		expect(d.config.clientSecret).toBe("owui-secret");
	});

	it("registers nothing from OPENID_PROVIDER_URL alone, which our deployments set for Hugging Face", () => {
		expect(orgOidcProvider({ OPENID_PROVIDER_URL: "https://huggingface.co", OPENID_CLIENT_ID: "hf" })).toEqual({
			register: false,
			reason: "unset",
		});
	});

	it("is off with nothing set", () => {
		expect(orgOidcProvider({})).toEqual({ register: false, reason: "unset" });
	});

	it("refuses a half-set provider and names what is missing, rather than registering a broken button", () => {
		const d = orgOidcProvider({ OIDC_ISSUER: OURS.OIDC_ISSUER, OIDC_CLIENT_ID: "alpha" });
		expect(d).toMatchObject({ register: false, reason: "incomplete" });
		expect(d.register === false && "detail" in d && d.detail).toContain("OIDC_CLIENT_SECRET");
	});

	it("refuses a plain-http issuer anywhere but this machine, so the client secret never crosses the network in the clear", () => {
		expect(orgOidcProvider({ ...OURS, OIDC_ISSUER: "http://login.example.org" })).toMatchObject({
			register: false,
			reason: "insecure-issuer",
		});
		expect(registered({ ...OURS, OIDC_ISSUER: "http://localhost:9999" }).config.discoveryUrl).toBe(
			"http://localhost:9999/.well-known/openid-configuration"
		);
	});

	it("refuses an issuer that is not a URL", () => {
		expect(orgOidcProvider({ ...OURS, OIDC_ISSUER: "login.example.org" })).toMatchObject({
			register: false,
			reason: "bad-issuer",
		});
	});

	it("names the button SSO when no display name is set, and reads scopes from either name", () => {
		const { OIDC_PROVIDER_NAME: _n, ...unnamed } = OURS;
		expect(registered(unnamed).name).toBe("SSO");
		expect(registered({ ...unnamed, OAUTH_SCOPES: "openid email groups" }).config.scopes).toEqual([
			"openid",
			"email",
			"groups",
		]);
	});
});

// genericOAuth's init() is what Better Auth's createAuthContext() awaits at startup.
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
async function initWith(configs: GenericOAuthConfig[]) {
	const plugin = genericOAuth({ config: configs });
	return plugin.init?.({ logger, socialProviders: [], baseURL: "https://app.example.test" } as unknown as Parameters<
		NonNullable<typeof plugin.init>
	>[0]);
}
type Built = { context: { socialProviders: Array<{ id: string }> } };
const ids = (r: unknown) => (r as Built).context.socialProviders.map((p) => p.id);

afterEach(() => {
	vi.unstubAllGlobals();
	logger.error.mockClear();
});

describe("an unreachable organisation issuer costs only its own button", () => {
	it("startup completes with discovery unreachable, the provider is absent, and the failure is logged", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			})
		);
		const other: GenericOAuthConfig = {
			providerId: "other",
			clientId: "x",
			clientSecret: "y",
			authorizationUrl: "https://other.example/authorize",
			tokenUrl: "https://other.example/token",
		};
		const r = await initWith([registered(OURS).config, other]);
		expect(ids(r)).not.toContain(ORG_OIDC_PROVIDER_ID);
		expect(ids(r)).toContain("other");
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`"${ORG_OIDC_PROVIDER_ID}"`));
	});
});

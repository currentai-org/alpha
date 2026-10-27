import { describe, it, expect, vi, afterEach } from "vitest";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { huggingFaceOAuthConfig, memoizeAuthUntilRejected } from "./authStartup";

const HF = { providerUrl: "https://huggingface.co", clientId: "hf-test-client", scopes: ["openid", "email"] };
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

// genericOAuth's init() is what Better Auth's createAuthContext() awaits, in a loop with no
// per-plugin catch, so a throw here is a throw for every sign-in method on the instance.
async function initWith(config: GenericOAuthConfig) {
	const plugin = genericOAuth({ config: [config] });
	return plugin.init?.({ logger, socialProviders: [], baseURL: "https://app.example.test" } as unknown as Parameters<
		NonNullable<typeof plugin.init>
	>[0]);
}

function discoveryUnreachable() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("fetch failed");
		})
	);
}

const HF_DISCOVERY = {
	issuer: "https://huggingface.co",
	authorization_endpoint: "https://huggingface.co/oauth/authorize",
	token_endpoint: "https://huggingface.co/oauth/token",
	userinfo_endpoint: "https://huggingface.co/oauth/userinfo",
	jwks_uri: "https://huggingface.co/oauth/jwks",
	id_token_signing_alg_values_supported: ["RS256"],
};

function discoveryReturns(doc: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } }))
	);
}

type Built = { context: { socialProviders: Array<{ id: string; issuer?: string; idToken?: unknown }> } };
const hfProvider = (r: unknown) => (r as Built).context.socialProviders.find((p) => p.id === "huggingface");

afterEach(() => {
	vi.unstubAllGlobals();
	logger.error.mockClear();
});

describe("Hugging Face discovery failure stays contained to HF (CUR-2128)", () => {
	it("init resolves with HF discovery unreachable, skips HF, and logs the failure instead of throwing", async () => {
		discoveryUnreachable();
		const r = await initWith(huggingFaceOAuthConfig(HF));
		expect(hfProvider(r)).toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('"huggingface"'));
	});

	it("skips HF when discovery has no jwks_uri, so a degraded instance never accepts an HF ID token unverified", async () => {
		const { jwks_uri: _dropped, ...noJwks } = HF_DISCOVERY;
		discoveryReturns(noJwks);
		const r = await initWith(huggingFaceOAuthConfig(HF));
		expect(hfProvider(r)).toBeUndefined();
		expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("requires verified ID tokens"));
	});

	it("control: without requireIdTokenVerification the same document registers HF with no ID-token check", async () => {
		const { jwks_uri: _dropped, ...noJwks } = HF_DISCOVERY;
		discoveryReturns(noJwks);
		const { requireIdTokenVerification: _off, ...previous } = huggingFaceOAuthConfig(HF);
		const r = await initWith(previous);
		expect(hfProvider(r)).toBeDefined();
		expect(hfProvider(r)?.idToken).toBeUndefined();
	});

	it("registers HF with ID-token verification and the discovered issuer, so existing HF accounts keep their key", async () => {
		discoveryReturns(HF_DISCOVERY);
		const r = await initWith(huggingFaceOAuthConfig(HF));
		expect(hfProvider(r)?.idToken).toBeDefined();
		expect(hfProvider(r)?.issuer).toBe("https://huggingface.co");
	});

	it("keeps endpoints on discovery rather than hardcoding them", () => {
		const c = huggingFaceOAuthConfig(HF);
		expect(c.discoveryUrl).toBe("https://huggingface.co/.well-known/openid-configuration");
		expect(c.authorizationUrl).toBeUndefined();
		expect(c.tokenUrl).toBeUndefined();
		expect(c.userInfoUrl).toBeUndefined();
	});
});

describe("memoizeAuthUntilRejected (CUR-2128)", () => {
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("rebuilds after a rejected context instead of serving the dead one until the instance recycles", async () => {
		const build = vi
			.fn()
			.mockImplementationOnce(() => ({ $context: Promise.reject(new Error("init failed")) }))
			.mockImplementation(() => ({ $context: Promise.resolve("ok") }));
		const getAuth = memoizeAuthUntilRejected(build);
		const first = getAuth();
		await settle();
		const second = getAuth();
		expect(second).not.toBe(first);
		await expect(second.$context).resolves.toBe("ok");
		expect(build).toHaveBeenCalledTimes(2);
	});

	it("builds once while the context is healthy", async () => {
		const build = vi.fn(() => ({ $context: Promise.resolve("ok") }));
		const getAuth = memoizeAuthUntilRejected(build);
		const first = getAuth();
		await settle();
		expect(getAuth()).toBe(first);
		expect(build).toHaveBeenCalledTimes(1);
	});
});

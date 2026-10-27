import { describe, it, expect, vi } from "vitest";
import { genericOAuth, type GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { mockOidcProvider } from "./mockOidc";

const SET = {
	url: "http://localhost:8080/",
	clientId: "potluck-preview-test",
	clientSecret: "not-a-real-secret",
};

describe("mockOidcProvider (CUR-1551)", () => {
	it("refuses to register on production even with every var set, and names production as the reason", () => {
		expect(mockOidcProvider({ deployEnv: "production", ...SET })).toEqual({
			register: false,
			reason: "production",
		});
	});

	it("registers on a preview deployment with every var set", () => {
		const d = mockOidcProvider({ deployEnv: "preview", ...SET });
		expect(d.register).toBe(true);
		if (d.register) expect(d.config.providerId).toBe("mock-oidc");
	});

	it("never takes the Hugging Face provider's id, so it cannot replace real HF sign-in", () => {
		const d = mockOidcProvider({ deployEnv: "preview", ...SET });
		if (!d.register) throw new Error("expected registration on preview");
		expect(d.config.providerId).not.toBe("huggingface");
	});

	it("configures explicit endpoints and NO discoveryUrl, so auth init makes no network call to the mock", () => {
		const d = mockOidcProvider({ deployEnv: "preview", ...SET });
		if (!d.register) throw new Error("expected registration on preview");
		expect(d.config.discoveryUrl).toBeUndefined();
		expect(d.config.authorizationUrl).toBe("http://localhost:8080/authorize");
		expect(d.config.tokenUrl).toBe("http://localhost:8080/token");
		expect(d.config.userInfoUrl).toBe("http://localhost:8080/userinfo");
	});

	it("stays absent when any of the three vars is missing", () => {
		expect(mockOidcProvider({ deployEnv: "preview", ...SET, clientSecret: undefined }).register).toBe(false);
		expect(mockOidcProvider({ deployEnv: "preview", ...SET, url: "" }).register).toBe(false);
	});

	it("registers on a development server too, where the local sign-in leg runs it (CUR-2451)", () => {
		expect(mockOidcProvider({ deployEnv: "development", ...SET }).register).toBe(true);
	});

	it("stays absent on an unrecognised environment", () => {
		expect(mockOidcProvider({ deployEnv: null, ...SET })).toEqual({ register: false, reason: "unknown-env" });
	});

	it("refuses a mock on a public host, so nobody outside the test run can sign in through it (CUR-2522)", () => {
		for (const url of ["https://mock-oidc.example.fly.dev", "https://localhost.example.org", "http://10.0.0.5:8080"]) {
			expect(mockOidcProvider({ deployEnv: "preview", ...SET, url }), url).toEqual({
				register: false,
				reason: "not-loopback",
			});
		}
	});

	it("accepts each loopback spelling", () => {
		for (const url of ["http://localhost:8080", "http://127.0.0.1:8080", "http://[::1]:8080"]) {
			expect(mockOidcProvider({ deployEnv: "preview", ...SET, url }).register, url).toBe(true);
		}
	});
});

// The guarantee mockOidc.ts exists to keep, run against the real plugin: genericOAuth's init() is
// what createAuthContext() awaits, and a throw from it takes every sign-in method down with it.
describe("mock-oidc cannot take the other providers down (CUR-1551)", () => {
	const DEAD = { deployEnv: "preview", ...SET, url: "http://127.0.0.1:9" };
	const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

	const registered = (r: unknown) =>
		(r as { context: { socialProviders: Array<{ id: string }> } }).context.socialProviders.map((p) => p.id);

	async function initWith(config: GenericOAuthConfig) {
		const plugin = genericOAuth({ config: [config] });
		return plugin.init?.({ logger, socialProviders: [], baseURL: "https://app.example.test" } as unknown as Parameters<NonNullable<typeof plugin.init>>[0]);
	}

	it("initialises with the mock host unreachable, and never calls the network to do it", async () => {
		const fetchSpy = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const d = mockOidcProvider(DEAD);
		if (!d.register) throw new Error("expected registration on preview");
		const r = await initWith(d.config);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(registered(r)).toContain("mock-oidc");
		vi.unstubAllGlobals();
	});

	it("control: the same dead host given as a discoveryUrl leaves the mock unregistered at startup, which is why there is none", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			})
		);
		const d = mockOidcProvider(DEAD);
		if (!d.register) throw new Error("expected registration on preview");
		const { authorizationUrl: _a, tokenUrl: _t, userInfoUrl: _u, ...rest } = d.config;
		const r = await initWith({ ...rest, discoveryUrl: `${DEAD.url}/.well-known/openid-configuration` });
		expect(registered(r)).not.toContain("mock-oidc");
		vi.unstubAllGlobals();
	});
});

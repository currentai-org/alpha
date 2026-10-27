import { describe, expect, it, afterEach } from "vitest";
import { getOIDCClient, type OIDCSettings } from "./auth";
import { OIDConfig } from "./oidcConfig";

// An unconfigured OIDC provider (empty OPENID_PROVIDER_URL/OPENID_CLIENT_ID — the local-dev
// default with no .env overrides) would reach `discovery(new URL(""), ...)`, which throws a bare
// TypeError with no SvelteKit error() wrapper. That surfaces through handleError as a generic "An error
// occurred" 500 with a correlation UUID and no indication sign-in isn't set up, and visiting /chat/login
// directly would render exactly that.
// directly rendered exactly that. The contract: an unconfigured provider must fail as a real SvelteKit
// HTTP error the caller (and +error.svelte) can render meaningfully, never a raw exception.
describe("getOIDCClient — unconfigured provider fails loud, not raw", () => {
	const original = { PROVIDER_URL: OIDConfig.PROVIDER_URL, CLIENT_ID: OIDConfig.CLIENT_ID };

	afterEach(() => {
		OIDConfig.PROVIDER_URL = original.PROVIDER_URL;
		OIDConfig.CLIENT_ID = original.CLIENT_ID;
	});

	const settings: OIDCSettings = { redirectURI: "http://localhost:5173/chat/login/callback" };

	it("throws a SvelteKit 503 error, not a raw TypeError, when PROVIDER_URL is empty", async () => {
		OIDConfig.PROVIDER_URL = "";
		OIDConfig.CLIENT_ID = "some-client-id";

		await expect(getOIDCClient(settings, new URL("http://localhost:5173"))).rejects.toMatchObject({
			status: 503,
		});
	});

	it("throws a SvelteKit 503 error, not a raw TypeError, when CLIENT_ID is empty", async () => {
		OIDConfig.PROVIDER_URL = "https://huggingface.co";
		OIDConfig.CLIENT_ID = "";

		await expect(getOIDCClient(settings, new URL("http://localhost:5173"))).rejects.toMatchObject({
			status: 503,
		});
	});
});

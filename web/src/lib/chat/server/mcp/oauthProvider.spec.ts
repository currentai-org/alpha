import { describe, expect, it } from "vitest";
import { open, SealedSecretError } from "$lib/chat/server/storage/locations/sealedSecret";
import { openOAuthState, RowOAuthProvider, sealOAuthState, type McpOAuthState } from "./oauthProvider";
import { sealServerToken } from "./userServers";

const SECRET = "test-secret";
const STATE: McpOAuthState = {
	client: { client_id: "client-1" },
	tokens: { access_token: "access-plain", token_type: "Bearer", refresh_token: "refresh-plain" },
};

describe("sealOAuthState", () => {
	it("keeps no token or client id in plain text at rest", () => {
		const sealed = sealOAuthState(STATE, SECRET);
		for (const plain of ["access-plain", "refresh-plain", "client-1"]) expect(sealed).not.toContain(plain);
		expect(openOAuthState(sealed, SECRET)).toEqual(STATE);
	});

	it("refuses to open under another secret (fails loud, never returns a guess)", () => {
		expect(() => openOAuthState(sealOAuthState(STATE, SECRET), "other-secret")).toThrow(SealedSecretError);
	});

	it("is sealed under its own info string, so a bearer credential never opens as OAuth state, nor the reverse", () => {
		expect(() => openOAuthState(sealServerToken("tok", SECRET), SECRET)).toThrow(SealedSecretError);
		expect(() => open(sealOAuthState(STATE, SECRET), SECRET)).toThrow(SealedSecretError);
	});
});

describe("RowOAuthProvider", () => {
	function provider(state: McpOAuthState = {}) {
		const saved: McpOAuthState[] = [];
		const p = new RowOAuthProvider({
			state,
			redirectUrl: "https://alpha.example/chat/api/connectors/mcp/callback",
			stateParam: "bound-state",
			persist: async (s) => void saved.push(s),
			now: () => 1234,
		});
		return { p, saved };
	}

	it("persists every change the SDK makes, and drops the PKCE verifier once tokens arrive", async () => {
		const { p, saved } = provider();
		await p.saveClientInformation({ client_id: "client-1" });
		await p.saveCodeVerifier("verifier-1");
		expect(p.codeVerifier()).toBe("verifier-1");
		await p.saveTokens({ access_token: "a", token_type: "Bearer" });
		expect(saved.at(-1)).toEqual({
			client: { client_id: "client-1" },
			tokens: { access_token: "a", token_type: "Bearer" },
			tokensSavedAt: 1234,
		});
		expect(() => p.codeVerifier()).toThrow();
	});

	it("records the authorization URL instead of navigating, since it runs server-side", () => {
		const { p } = provider();
		p.redirectToAuthorization(new URL("https://auth.example/authorize?x=1"));
		expect(p.authorizationUrl?.href).toBe("https://auth.example/authorize?x=1");
	});

	it("registers as a public client whose only redirect is our callback", () => {
		const { p } = provider();
		expect(p.clientMetadata.redirect_uris).toEqual(["https://alpha.example/chat/api/connectors/mcp/callback"]);
		expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
		expect(p.state()).toBe("bound-state");
	});

	it("forgets only what the SDK asks it to forget", async () => {
		const { p } = provider(STATE);
		await p.invalidateCredentials("tokens");
		expect(p.tokens()).toBeUndefined();
		expect(p.clientInformation()).toEqual({ client_id: "client-1" });
		await p.invalidateCredentials("all");
		expect(p.clientInformation()).toBeUndefined();
	});
});

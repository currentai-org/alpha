// The MCP authorization flow for a person's own MCP server, through the MCP SDK's client auth. The SDK
// does discovery, dynamic client registration, PKCE, the token exchange and refresh; this file is only
// where it keeps what it learns. Everything it saves for one server (the registered client, the tokens,
// the PKCE verifier of a sign-in in flight, the discovery result) is one JSON blob, sealed at rest under
// an info string of its own and stored in that server's `user_mcp_servers.oauth_state`.
import type {
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { credentialSecret, open, seal } from "$lib/chat/server/storage/locations/sealedSecret";

/** HKDF info for the OAuth blob, so neither a bearer credential nor a storage one opens as it. */
const SEAL_INFO = "aipotluck/user-mcp-server-oauth/v1"; // leakguard:allow (the HKDF info prefix every seal here uses)

export interface McpOAuthState {
	client?: StoredOAuthClientInformation;
	tokens?: StoredOAuthTokens;
	/** The PKCE verifier of the sign-in in flight; dropped once its code is exchanged. */
	verifier?: string;
	discovery?: OAuthDiscoveryState;
	/** When `tokens` was saved (ms), so `expires_in` can be read as a deadline. */
	tokensSavedAt?: number;
}

export function sealOAuthState(state: McpOAuthState, secret = credentialSecret()): string {
	return seal(JSON.stringify(state), secret, SEAL_INFO);
}

/** Throws SealedSecretError when the blob no longer opens (the sealing secret changed). */
export function openOAuthState(sealed: string, secret = credentialSecret()): McpOAuthState {
	return JSON.parse(open(sealed, secret, SEAL_INFO)) as McpOAuthState;
}

export interface RowOAuthProviderInit {
	state: McpOAuthState;
	/** Our callback on the public origin: `<origin>/chat/api/connectors/mcp/callback`. */
	redirectUrl: string;
	/** The OAuth `state` parameter, which binds the callback to this person and this server. */
	stateParam?: string;
	/** Writes the sealed state back to the row; called after every change the SDK makes. */
	persist: (state: McpOAuthState) => Promise<void>;
	now?: () => number;
}

/**
 * The SDK's OAuthClientProvider over one server row. The SDK runs server-side and has no browser, so
 * `redirectToAuthorization` only records `authorizationUrl`; the connect route sends the browser there.
 * During a turn nobody is waiting on a browser, so a recorded URL means the server needs reconnecting.
 */
export class RowOAuthProvider implements OAuthClientProvider {
	authorizationUrl: URL | undefined;
	readonly #redirectUrl: string;
	readonly #stateParam: string | undefined;
	readonly #persist: (state: McpOAuthState) => Promise<void>;
	readonly #now: () => number;
	#state: McpOAuthState;

	constructor(init: RowOAuthProviderInit) {
		this.#state = { ...init.state };
		this.#redirectUrl = init.redirectUrl;
		this.#stateParam = init.stateParam;
		this.#persist = init.persist;
		this.#now = init.now ?? Date.now;
	}

	/** What the provider holds now, after any change the SDK made. */
	get current(): McpOAuthState {
		return this.#state;
	}

	get redirectUrl(): string {
		return this.#redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Alpha",
			redirect_uris: [this.#redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// Public client with PKCE: there is no client secret to store.
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		if (!this.#stateParam) throw new Error("mcp oauth: no state parameter for a sign-in");
		return this.#stateParam;
	}

	clientInformation(): StoredOAuthClientInformation | undefined {
		return this.#state.client;
	}

	async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
		await this.#save({ ...this.#state, client });
	}

	tokens(): StoredOAuthTokens | undefined {
		return this.#state.tokens;
	}

	async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
		const { verifier: _exchanged, ...rest } = this.#state;
		await this.#save({ ...rest, tokens, tokensSavedAt: this.#now() });
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		this.authorizationUrl = authorizationUrl;
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		await this.#save({ ...this.#state, verifier });
	}

	codeVerifier(): string {
		if (!this.#state.verifier) throw new Error("mcp oauth: no sign-in in flight for this server");
		return this.#state.verifier;
	}

	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
		await this.#save({ ...this.#state, discovery });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.#state.discovery;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		const next = { ...this.#state };
		if (scope === "all" || scope === "client") delete next.client;
		if (scope === "all" || scope === "tokens") delete next.tokens;
		if (scope === "all" || scope === "verifier") delete next.verifier;
		if (scope === "all" || scope === "discovery") delete next.discovery;
		await this.#save(next);
	}

	async #save(next: McpOAuthState): Promise<void> {
		this.#state = next;
		await this.#persist(next);
	}
}

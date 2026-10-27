// Lazily-constructed, shared OpenMined SyftHub client for the Pattern-A federated-RAG path
// (discovery via hub.search + retrieval via search.query). Returns null when no token is configured
// so callers fail open to a normal answer.
//
// PAYING FOR METERED SOURCES — no login required. The aggregator (`search.query`) only settles a
// `402 Payment Required` when the SDK forwards a `user_token`, which it reads from the JWT access
// token slot (`auth.getAccessToken()` → `http.getTokens()?.accessToken`). Building the client with an
// API PAT alone leaves that slot null, so no `user_token` is sent and metered sources 402. We inject
// the PAT into that slot via the public `setTokens(...)`, so the SDK forwards the PAT as `user_token`
// and the aggregator settles MPP via the PAT's Hub wallet — exactly like the direct `/api/v1/wallet/pay`
// path. This works against syfthub.openmined.org metered sources. `setTokens` nulls the apiToken, but the bearer is still the PAT (`getBearerToken()` =
// apiToken ?? accessToken), so authenticated calls (hub.get, satellite-token minting) are unaffected.

import { SyftHubClient } from "@syfthub/sdk";
import { syft } from "./env";
import { logger } from "$lib/chat/server/logger";

let client: SyftHubClient | null = null;
let builtFor = "";
// Monotonic build generation: bumped each time the client is rebuilt (token/base change). The
// discovery cache mixes this — NOT the raw token — into its key, so a rebuild invalidates cached
// picks without ever keeping the secret as a map key.
let generation = 0;

// Whether the token is configured is a STATIC fact once the process is up (env doesn't change turn
// to turn) — warn once, not on every caller's every turn. Same posture as localStore.ts's
// warnedModelMismatch (CUR-879), same underlying failure class (CUR-878): every caller
// (syftSources.ts, syftCatalog.ts) treats a null client identically to "queried, found nothing", with
// nothing distinguishing "not configured here" from a real empty result, so the missing token is logged.
let warnedUnconfigured = false;

export function getSyftClient(): SyftHubClient | null {
	const { token, baseUrl } = syft();
	if (!token) {
		if (!warnedUnconfigured) {
			warnedUnconfigured = true;
			logger.warn(
				{ baseUrl },
				"[rag] SyftHub token not configured — every turn silently skips federated RAG in this environment"
			);
		}
		return null;
	}
	// Rebuild if the token/base changed (e.g. via the config manager at runtime).
	const key = `${baseUrl}::${token}`;
	if (!client || builtFor !== key) {
		client = new SyftHubClient({ baseUrl, apiToken: token });
		builtFor = key;
		generation += 1;
	}
	// Idempotently (re)assert the PAT as the aggregator's MPP `user_token`. Also self-heals: the SDK
	// clears its tokens if a 401 triggers a refresh that fails (a PAT is not a refresh JWT), so a
	// transient auth blip can't permanently stop us sending the user_token — the next call re-injects.
	if (client.getTokens() === null) {
		client.setTokens({ accessToken: token, refreshToken: token, tokenType: "bearer" });
	}
	return client;
}

/** Opaque cache-invalidation token for the current client build (`gen-N`), or `gen-0` if no client
 *  is built. Changes on every rebuild so the discovery cache invalidates — without embedding the
 *  raw API token in the cache key. */
export function syftClientBuildKey(): string {
	return `gen-${generation}`;
}

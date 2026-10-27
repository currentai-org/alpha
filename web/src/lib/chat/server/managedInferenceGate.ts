/**
 * Managed (tunnel-provisioned) local-inference endpoints, gated separately from the base local
 * (LAN/self-hosted) feature (localEndpointsGate.ts) — its own PostHog flag since CUR-3175, declared
 * in the registry as a subset of `local-inference` rather than left as a relationship the prose only
 * implies (CUR-1085 is what that costs when it drifts). Deliberately NOT
 * `localInferenceEndpointsEnabled() && <pangolin config>` collapsed into one question: managed endpoints need a whole separate piece of
 * infra (Pangolin, see pangolin/README.md) that the base feature never did, and keeping this a
 * second, independently-named gate is what let CUR-771 catch registration/access drift for
 * agent-mode (agentMode.ts's `agentModeEnabled()` vs `agentModeEnabledForUser()`) — the same
 * precedent applies here: a future reason to turn managed off while direct stays on (or vice versa)
 * should be a one-line change to THIS function, not an unpicking of a shared one.
 */
import { config } from "$lib/chat/server/config";
import { deployEnv } from "$lib/chat/server/deployEnv";
import { flagEnabledOr } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";

/** PostHog flag key. Owner: chat. Gates the managed (tunnel-provisioned) half of local inference.
 *  A subset of LOCAL_INFERENCE_FLAG — see this key's `requires` in flagKeys.ts. */
export const LOCAL_INFERENCE_MANAGED_FLAG = "local-inference-managed";

/** The configured Pangolin Integration API base URL, or "" — a URL, NOT a feature gate. */
export function pangolinApiUrl(): string {
	return ((Reflect.get(config, "PANGOLIN_API_URL") as string | undefined) ?? "").trim();
}

/** The org-scoped Integration API bearer token, or "". */
export function pangolinIntegrationToken(): string {
	return ((Reflect.get(config, "PANGOLIN_INTEGRATION_TOKEN") as string | undefined) ?? "").trim();
}

export function pangolinOrgId(): string {
	return ((Reflect.get(config, "PANGOLIN_ORG_ID") as string | undefined) ?? "").trim();
}

export function pangolinDomainId(): string {
	return ((Reflect.get(config, "PANGOLIN_DOMAIN_ID") as string | undefined) ?? "").trim();
}

/** What we hand the CLIENT to dial (aipotluck-local-client's `--tunnel-endpoint`) — distinct from
 *  `pangolinApiUrl()`, which is server-to-server only and never reaches the user's machine. */
export function pangolinTunnelEndpoint(): string {
	return ((Reflect.get(config, "PANGOLIN_TUNNEL_ENDPOINT") as string | undefined) ?? "").trim();
}

/** Is the managed-endpoint FEATURE on for this deployment at all — the gate the Settings UI reads to
 *  decide whether the "Add a managed server" block renders. Sync, never throws, no network call —
 *  `flagEnabledOr` reads a polled snapshot.
 *
 *  Deliberately NOT whether Pangolin is actually configured/reachable right now — that's
 *  `pangolinConfigured()`/a live probe (managed/availability/+server.ts), a separate, dynamic
 *  question the UI answers by disabling the Pair control rather than hiding the whole block.
 *
 *  A PostHog flag decides, with deployEnv() passed into the evaluation as a person property rather
 *  than consulted here — same shape and same reasoning as localInferenceEndpointsEnabled(), whose
 *  header carries the full argument. The fallback is on in local development only, so a laptop
 *  without PostHog can still exercise the feature while a real deployment stays dark. */
export function managedLocalInferenceEndpointsEnabled(): boolean {
	return flagEnabledOr(LOCAL_INFERENCE_MANAGED_FLAG, () => deployEnv() === "development");
}


/** Is every Pangolin env var actually present? Sync, no network — config presence only, not
 *  reachability. A missing var on an otherwise-enabled deployment is a LOUD config error (logged),
 *  never a silent off, matching agentModeEnabled()'s posture. */
export function pangolinConfigured(): boolean {
	const missing = [
		["PANGOLIN_API_URL", pangolinApiUrl()],
		["PANGOLIN_INTEGRATION_TOKEN", pangolinIntegrationToken()],
		["PANGOLIN_ORG_ID", pangolinOrgId()],
		["PANGOLIN_DOMAIN_ID", pangolinDomainId()],
		["PANGOLIN_TUNNEL_ENDPOINT", pangolinTunnelEndpoint()],
	].filter(([, value]) => !value);

	if (missing.length > 0) {
		logger.warn(
			`[managedInference] managed endpoints are enabled but ${missing.map(([k]) => k).join(", ")} ${
				missing.length > 1 ? "are" : "is"
			} unset — provisioning withheld (config error, not a feature toggle)`
		);
		return false;
	}

	return true;
}

/** Should a provisioning/status/revoke API call actually be allowed through? The composed,
 *  server-authoritative check every route in this feature gates on — deployment flag AND config
 *  present. The UI's own two separate signals (block visibility vs Pair-button availability) exist
 *  so a visitor sees WHY it's unavailable instead of a bare 404; this is the one the API enforces
 *  regardless of what the client believed. */
export function managedInferenceEnabled(): boolean {
	return managedLocalInferenceEndpointsEnabled() && pangolinConfigured();
}

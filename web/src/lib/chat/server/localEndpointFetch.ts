import { deployEnv } from "$lib/chat/server/deployEnv";
import { metadataGuardedFetch, ssrfStrictFetch } from "$lib/chat/server/urlSafety";

// Both read process.env at call time, as moderation.ts's isSelfHostEdition does: not the config
// manager, whose database overrides must not be able to widen what the server may reach, and not a
// module-level const, so a spec can set them per test.

/** LOCAL_INFERENCE_INTERNAL_ADDRESSES=allow: the operator says the people signed in here may reach the
 *  host's own network (their LAN Ollama on a single-user install). Only the exact value "allow" counts. */
function operatorAllowsPrivateAddresses(): boolean {
	return (process.env.LOCAL_INFERENCE_INTERNAL_ADDRESSES ?? "").trim().toLowerCase() === "allow";
}

function selfHostEdition(): boolean {
	return (process.env.ALPHA_EDITION ?? "").trim().toLowerCase() === "selfhost";
}

/**
 * Whether a local inference endpoint may point at a private address.
 *
 * When the operator opts in with LOCAL_INFERENCE_INTERNAL_ADDRESSES=allow, and otherwise only in local
 * development of the hosted app, where the server runs on the visitor's own machine and `localhost`
 * means their Ollama. A self-host edition never infers it from DEPLOY_ENV: its compose file defaults
 * DEPLOY_ENV to development on every install, shared ones included, and there a private address names
 * the host's network. On any hosted deployment reaching one is a server-side request forgery against
 * us. An undeclared environment counts as hosted.
 */
export function privateLocalAddressesAllowed(): boolean {
	if (operatorAllowsPrivateAddresses()) return true;
	if (selfHostEdition()) return false;
	return deployEnv() === "development";
}

/**
 * The fetch every request to a user's local inference endpoint goes through: model discovery, the
 * Ollama prewarm, and the chat turn itself. Where private addresses are refused it is `ssrfStrictFetch`,
 * which refuses a private IP literal, checks the resolved address at connect time, and re-checks every
 * redirect hop. That covers rows stored before create-time validation existed, and hostnames that
 * resolve to a private address. Where they are allowed it is `metadataGuardedFetch`, which makes the
 * same three checks for cloud-metadata and container-credential addresses only.
 *
 * Callers pass a URL and an init. A `Request` is reduced to its URL, so pass its method and body in
 * `init`; the OpenAI SDK already calls fetch that way.
 */
export function localEndpointFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	const target = url instanceof Request ? url.url : url;
	if (privateLocalAddressesAllowed()) return metadataGuardedFetch(target, init);
	return ssrfStrictFetch(target, init);
}

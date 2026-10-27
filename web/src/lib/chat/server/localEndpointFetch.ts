import { deployEnv } from "$lib/chat/server/deployEnv";
import { ssrfStrictFetch } from "$lib/chat/server/urlSafety";

/**
 * Whether a local inference endpoint may point at a private address (CUR-3387).
 *
 * Only in local development, where the server runs on the visitor's own machine and `localhost`
 * means their Ollama. On any hosted deployment a private address names the host's network, so
 * reaching one is a server-side request forgery against us. An undeclared environment counts as
 * hosted.
 */
export function privateLocalAddressesAllowed(): boolean {
	return deployEnv() === "development";
}

/**
 * The fetch every request to a user's local inference endpoint goes through: model discovery, the
 * Ollama prewarm, and the chat turn itself. Outside local development it is `ssrfStrictFetch`, which
 * refuses a private IP literal, checks the resolved address at connect time, and re-checks every
 * redirect hop. That covers rows stored before create-time validation existed, and hostnames that
 * resolve to a private address.
 *
 * Callers pass a URL and an init. A `Request` is reduced to its URL, so pass its method and body in
 * `init`; the OpenAI SDK already calls fetch that way.
 */
export function localEndpointFetch(url: string | URL | Request, init?: RequestInit): Promise<Response> {
	if (privateLocalAddressesAllowed()) return fetch(url, init);
	return ssrfStrictFetch(url instanceof Request ? url.url : url, init);
}

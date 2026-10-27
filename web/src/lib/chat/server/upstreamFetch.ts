import { Agent, fetch as undiciFetch } from "undici";
import { mistralChatLane } from "$lib/chat/server/mistralKey";

/**
 * How long an idle connection to the Mistral router stays in our pool.
 *
 * @remarks
 * The router (`router.stg`, AWS us-east-1) holds an idle HTTP/1.1 connection for 60 s and sends no
 * `Keep-Alive: timeout=` hint, so undici falls back to its 4 s default and closes the socket first.
 * Every call then opens a new one: DNS, TCP and a TLS 1.2 handshake, three round trips before the
 * request's own. From fra1 that is about 270 ms per call. 50 s stays under the router's 60 s, so we
 * never write to a socket it is about to close.
 */
const ROUTER_KEEPALIVE_MS = 50_000;

const routerAgent = new Agent({ keepAliveTimeout: ROUTER_KEEPALIVE_MS, keepAliveMaxTimeout: ROUTER_KEEPALIVE_MS });

function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
}

/** True when `url` is on the router's origin, the one host whose connections we keep warm. */
function onRouterOrigin(url: string, routerBase = mistralChatLane().baseURL): boolean {
	const router = originOf(routerBase);
	return router !== "" && originOf(url) === router;
}

/**
 * `fetch` for our own upstream lanes: a call to the router goes through a pool that keeps its
 * connection open between calls. Every other URL, and any `Request` object, uses global fetch.
 */
export async function upstreamFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	if (input instanceof Request) return fetch(input, init);
	const url = input.toString();
	if (!onRouterOrigin(url)) return fetch(url, init);
	return (await undiciFetch(url, {
		...(init as Parameters<typeof undiciFetch>[1]),
		dispatcher: routerAgent,
	})) as unknown as Response;
}

/**
 * Opens the router connection while a turn does its retrieval, so the turn's first model call finds
 * it ready instead of paying the handshake. Fire and forget: a failure only means that call opens
 * its own connection, as before.
 */
export function preconnectRouter(): void {
	const base = mistralChatLane().baseURL;
	const origin = originOf(base);
	if (!origin || !onRouterOrigin(base)) return;
	void undiciFetch(`${origin}/health/liveliness`, {
		dispatcher: routerAgent,
		signal: AbortSignal.timeout(5_000),
	})
		.then((res) => res.arrayBuffer())
		.catch(() => undefined);
}

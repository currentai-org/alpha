import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "$lib/chat/server/logger";
import { getRequestContext } from "$lib/chat/server/requestContext";

// A scenario run answers every model call from the replay store (modelReplay.ts) or a mock, so CI spends
// none of the provider allowances production shares. A call site that builds its own `fetch` to a model
// skips that store and goes live on every run, and nothing says so: the turn still answers.
//
// This makes that miss loud. In a request that carries a replay mode, a model-shaped call that does not
// go through replayOrRecord logs `[replay] bypass` with its host and path (never the body). The log is
// the whole effect for now: the call still goes out, so a new gate cannot break a run before its
// findings have been read.

const throughReplayLayer = new AsyncLocalStorage<true>();

/** Runs a live call the replay layer itself decided to make (a recording miss), so the guard does not
 *  report it as a bypass. */
export function liveThroughReplayLayer<T>(fn: () => T): T {
	return throughReplayLayer.run(true, fn);
}

// The OpenAI-compatible routes every model host we call serves, plus the groundcheck detector's. A GET to
// a search engine or a write to the replay store matches none of them.
const MODEL_PATH = /\/(?:chat\/completions|completions|embeddings|audio\/speech|audio\/transcriptions|rerank|detect)\/?$/;
// The Hugging Face inference router serves models under per-provider paths that the list above misses.
const MODEL_HOSTS = new Set(["router.huggingface.co"]);

function urlOf(input: string | URL | Request): URL | null {
	try {
		return new URL(input instanceof Request ? input.url : String(input));
	} catch {
		return null;
	}
}

/**
 * Logs `[replay] bypass` when `input` is a model call leaving a scenario request outside the replay
 * layer. Returns whether it did. Production requests carry no replay mode, so this never logs there.
 */
export function noteReplayBypass(input: string | URL | Request): boolean {
	const context = getRequestContext();
	if (!context?.replayMode || throughReplayLayer.getStore()) return false;
	const url = urlOf(input);
	if (!url || (!MODEL_PATH.test(url.pathname) && !MODEL_HOSTS.has(url.host))) return false;
	logger.warn(
		{ host: url.host, path: url.pathname, route: context.url, mode: context.replayMode },
		"[replay] bypass: a model call in a scenario request went live outside the recording layer"
	);
	return true;
}

let installed = false;

/** Wraps `globalThis.fetch` once so every raw model call in a scenario request is checked. */
export function installReplayBypassGuard(): void {
	if (installed) return;
	installed = true;
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		noteReplayBypass(input);
		return realFetch(input, init);
	}) as typeof fetch;
}

import type { ClientOptions } from "openai";
import type OpenAI from "openai";
import { config } from "$lib/chat/server/config";
import { getRequestContext } from "$lib/chat/server/requestContext";
import { upstreamFetch } from "$lib/chat/server/upstreamFetch";

/**
 * The ONLY sanctioned constructor for the OpenAI SDK client. Do NOT `new OpenAI(...)` anywhere
 * else — `scripts/verify-openai-retries.mjs` is the deterministic gate that fails the build if you do.
 *
 * WHY THIS EXISTS (CUR-65). The SDK default is `maxRetries: 2`, which retries 429/5xx with backoff.
 * Under sustained upstream rate-limiting those retries multiply the call count
 * AND hold the invocation open on backoff waits: a retry storm that pins CPU and ends in 504s. A cap
 * pasted by hand at each call site is one chance to forget per site, and a new site added anywhere
 * silently gets `2` back.
 *
 * This factory removes the by-omission path structurally: `maxRetries` is `Omit`-ted from the
 * parameter type, so a caller can neither forget the cap (the factory always applies it) nor set it
 * back to a dangerous value (the type won't let them). Default is 0 (calls fail open); set
 * `OPENAI_MAX_RETRIES` to enable a single controlled retry if ever needed.
 *
 * Async + an internal dynamic `import("openai")` preserves the lazy-load every call site already
 * used, keeping the SDK off the cold-start critical path.
 *
 * WHY `timeout` IS REQUIRED (CUR-1069, CUR-1345). The SDK default is ten minutes, which is longer
 * than this platform will even run a function for (PLATFORM_MAX_DURATION_MS is 300s), so in practice
 * an omitted `timeout` means no timeout at all. A blocking pre-pass on the turn's critical path (a
 * search or arithmetic classifier) can have a `catch` that fails open correctly and never runs,
 * because an upstream that hangs never throws.
 *
 * `maxRetries` is solved by omission — the factory supplies it and the type forbids overriding it.
 * A timeout cannot work that way: the streaming turn lane, the forced-tool-call round trip, and a
 * cheap yes/no gate all need genuinely different values (300s, 15s, 8s among the call sites this
 * repo has today), and any default this factory picked would be wrong for most of them. So the type
 * requires the caller to STATE one. Choosing badly is a visible decision in a diff; forgetting is
 * not.
 */
export async function createOpenAIClient(
	opts: Omit<ClientOptions, "maxRetries"> & { timeout: number }
): Promise<OpenAI> {
	const { OpenAI } = await import("openai");
	return new OpenAI({
		...opts,
		fetch: opts.fetch ?? replayAwareFetch,
		maxRetries: Number(Reflect.get(config, "OPENAI_MAX_RETRIES")) || 0,
	});
}

/**
 * A scenario run's SDK calls (search classifier, turn planner, task-model tool calls, MCP
 * router) replay like its answer does. Outside such a request this is plain `fetch`. A caller that
 * passes its own `fetch` (endpointOai.ts) handles replay there. (SOL-148)
 */
export async function replayAwareFetch(
	url: string | URL | Request,
	init?: RequestInit,
	/** `liveOnMiss`: see replayOrRecord. The SDK passes only the first two arguments, so its calls never set it. */
	opts: { liveOnMiss?: boolean } = {}
): Promise<Response> {
	const mode = getRequestContext()?.replayMode;
	if (!mode) return upstreamFetch(url, init);
	const { replayOrRecord } = await import("$lib/chat/server/endpoints/openai/modelReplay");
	return replayOrRecord(url, init, (i) => upstreamFetch(url, i), { sdkCall: true }, mode, opts);
}

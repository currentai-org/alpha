import type { ProcessedModel } from "$lib/chat/server/models";
import type { AgentMode } from "$lib/chat/stores/agentMode";
import { logger } from "$lib/chat/server/logger";
import { endpointApiKey } from "$lib/chat/server/endpointKey";

/**
 * Decide which model actually answers this turn, given the composer's Agent control (off / auto / on).
 *
 * This is the chat's HALF of "invoke the agent the way Claude does for tasks that benefit from agentic
 * work": Claude's trick isn't running an agent, it's DECIDING a turn deserves one. That decision lives here.
 *   off  → the conversation's selected model (no change).
 *   on   → force the Potluck agent model (potluck-agent).
 *   auto → ask the agent service's POST /route classifier (an open model + the bare forced-choice harness
 *          trick, server-side) whether THIS turn benefits from multi-step agentic work; route iff it says so.
 *
 * Fail-OPEN everywhere: if the agent model isn't configured (AGENT_SERVICE_URL unset), or /route errors,
 * times out, or returns non-OK, fall back to the selected model. The toggle can never wedge a turn — the
 * worst case is "answered normally". This mirrors the agent service's own /route, which fails open to DIRECT.
 *
 * A pluggable seam by design: this is the one function to change when routing evolves. If the model
 * decides natively mid-stream (emits a hand-off tool call), swapping the strategy here — not the
 * request path or the wire contract — is the whole migration.
 */

export const AGENT_MODEL_ID = "potluck-agent";
const ROUTE_TIMEOUT_MS = 20_000; // the classify is a single small model call; bound it well under the run wall-clock

export interface AgentRouteDecision {
	model: ProcessedModel;
	route: "selected" | "agent";
	reason: string;
	/** Auto asked /route and got no verdict (non-OK, timeout, network, unreadable body), so the
	 *  selected model answers a turn nobody judged ordinary. The route puts a note on that answer; a (CUR-2830)
	 *  "direct" verdict leaves this unset and stays silent. */
	failed?: true;
}

/** A closed set, not the raw error text — "log the reason, not just that it happened" only
 *  means something if the reason can be counted and grouped, and a raw `err` field can't. Module- (CUR-1260)
 *  private: nothing outside this file needs the type, only the `reason` string it feeds. */
type RouteFailureReason = "http_error" | "timeout" | "network" | "parse_error" | "unknown";

function classifyRouteFailure(err: unknown): RouteFailureReason {
	if (err instanceof Error) {
		// AbortSignal.timeout's own failure name (moderation.ts's WARM_COOP_TIMEOUT_MS comment:
		// "warm Coop ping failed … TimeoutError").
		if (err.name === "TimeoutError") return "timeout";
		if (err.name === "SyntaxError") return "parse_error"; // res.json() on a non-JSON 2xx body
		// Node/undici wraps DNS/connection-refused/TLS failures as TypeError("fetch failed"), with the
		// real cause on `.cause` — logged alongside, not parsed here, since the closed set only needs
		// to answer "which of the four buckets", not re-derive the underlying libuv errno.
		if (err.name === "TypeError") return "network";
	}
	return "unknown";
}

// A bare occurrence count says nothing about frequency. Same shape as errorTracking.ts's
// errorCount: an in-process counter, read-and-reset by the warm cron so the value is a rate over one tick, not an
// unbounded total. Kept local to this module (not folded into errorTracking.ts's generic exception
// counter) because a route-classifier fallback is an intentional fail-open path, not an unhandled
// exception — conflating the two rates would hide either signal inside the other. (CUR-1260)
let routeFailureCount = 0;

/** Read and RESET the count. Call once per warm tick. */
export function takeAgentRouteFailureCount(): number {
	const n = routeFailureCount;
	routeFailureCount = 0;
	return n;
}

/**
 * Every turn with the Agent control on or auto logs the decision and its reason, including the
 * turns that fall back to the selected model. A forced "on" that
 * answered with plain chat would otherwise leave no trace in any log search. A forced "on" that falls back logs at warn:
 * the person asked for the agent and did not get it. (CUR-905)
 */
export async function resolveAgentRoute(
	opts: Parameters<typeof decideAgentRoute>[0]
): Promise<AgentRouteDecision> {
	const decision = await decideAgentRoute(opts);
	if (opts.agentMode && opts.agentMode !== "off") {
		const fields = {
			agentMode: opts.agentMode,
			route: decision.route,
			reason: decision.reason,
			from: opts.selected.id,
		};
		if (opts.agentMode === "on" && decision.route !== "agent") {
			logger.warn(fields, "[agent-route] forced on, answered by the selected model");
		} else {
			logger.info(fields, "[agent-route] resolved");
		}
	}
	return decision;
}

async function decideAgentRoute(opts: {
	selected: ProcessedModel;
	models: ProcessedModel[];
	agentMode: AgentMode | undefined;
	prompt: string | undefined;
	/** Per-user access gate (CUR-121). `false` means THIS request's user is not cleared for agent mode,
	 *  so deny before any routing intent is honoured — a non-tester can't force-on or auto-route even by
	 *  POSTing `agentMode:"on"`. `undefined` (the default) is ungated, preserving behaviour for callers
	 *  and tests that don't scope by user. This is the turn-resolution half of the fail-closed surface;
	 *  the UI toggle and model list gate the same identity upstream. */
	agentAllowed?: boolean;
	/** The turn attaches a document the chat path will read to text (CUR-987). The agent builds its
	 *  task from message text alone (endpointAgent.ts `buildTaskPrompt`), so it never sees that text;
	 *  in auto mode such a turn stays on the selected model. A forced-on turn is the user's choice
	 *  and still goes to the agent. */
	carriesDocument?: boolean;
	/** This turn attaches an image. The agent endpoint forwards text only, so an image turn the
	 *  classifier sends to the agent loses its image (CUR-454). */
	hasImage?: boolean;
	/** The person set web search to Always. The agent cannot search: its sandbox has no network and its
	 *  endpoint drops the chat's retrieved evidence (CUR-574), so a search-Always turn it took would answer
	 *  saying it could not reach the web. In auto mode such a turn stays on the selected model, which
	 *  searches first and can still run code through the chat's sandbox tools. A forced-on turn is the
	 *  person's choice and still goes to the agent. */
	webSearchAlways?: boolean;
	/** Injectable for tests; defaults to the platform fetch. */
	fetchImpl?: typeof fetch;
}): Promise<AgentRouteDecision> {
	const { selected, models, agentMode, prompt, agentAllowed, carriesDocument } = opts;
	const doFetch = opts.fetchImpl ?? fetch;

	if (!agentMode || agentMode === "off") {
		return { model: selected, route: "selected", reason: "agent off" };
	}

	// Fail-closed per-user gate: an explicit `false` denies agent routing before force-on / auto-classify,
	// so the worst a non-tester can do by hand-POSTing agentMode is get answered by their selected model.
	if (agentAllowed === false) {
		return { model: selected, route: "selected", reason: "agent not allowed for user" };
	}

	const agent = models.find((m) => m.id === AGENT_MODEL_ID);
	if (!agent) {
		// AGENT_SERVICE_URL unset → the toggle is inert (the agent model was never registered). Answer normally.
		return { model: selected, route: "selected", reason: "agent model not configured" };
	}

	if (agentMode === "on") {
		return { model: agent, route: "agent", reason: "forced on" };
	}

	if (carriesDocument) {
		return { model: selected, route: "selected", reason: "auto: turn carries a document" };
	}

	// auto never hands an image turn to the agent: it can't see the image, and the classifier reads the
	// prompt alone, so "what colour is the circle?" reads as image analysis and would go
	// there (CUR-454).
	if (opts.hasImage) {
		return { model: selected, route: "selected", reason: "auto: image turn, which the agent can't read" };
	}

	// auto never hands a search-Always turn to the agent: it can't search, so the turn would answer
	// ungrounded against the person's explicit setting. The selected model's path runs the search.
	if (opts.webSearchAlways) {
		return { model: selected, route: "selected", reason: "auto: web search is Always, which the agent can't run" };
	}

	// auto: classify via the agent service. No prompt to classify (retry / continue) → answer normally.
	const task = (prompt ?? "").trim();
	if (!task) {
		return { model: selected, route: "selected", reason: "auto: no prompt to classify" };
	}

	const ep = agent.endpoints?.[0] as { baseURL?: string; apiKeyEnv?: string } | undefined;
	const baseURL = ep?.baseURL?.replace(/\/$/, "");
	if (!baseURL) {
		return { model: selected, route: "selected", reason: "auto: agent baseURL missing" };
	}

	try {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const apiKey = endpointApiKey(ep);
		if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
		const res = await doFetch(`${baseURL}/route`, {
			method: "POST",
			headers,
			body: JSON.stringify({ prompt: task }),
			signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS),
		});
		// /route runs the agent service's own input screen first and answers 403 "blocked by
		// moderation" when it refuses. The service was reached and gave a verdict, so the turn goes to the
		// selected model's path, where the chat's own screen decides, with no "agent wasn't reachable" note. (CUR-4056)
		if (res.status === 403) {
			const body = await res.text().catch(() => "");
			if (body.includes("blocked by moderation")) {
				logger.info({ status: 403 }, "[agent-route] /route input screen refused; answering normally");
				return { model: selected, route: "selected", reason: "auto: agent input screen refused the prompt" };
			}
		}
		if (!res.ok) {
			routeFailureCount++;
			logger.warn(
				{ status: res.status, reason: "http_error" satisfies RouteFailureReason },
				"[agent-route] /route non-OK; answering normally"
			);
			return { model: selected, route: "selected", reason: `auto: route http ${res.status}`, failed: true };
		}
		const d = (await res.json()) as { agentic?: boolean; reason?: string };
		return d?.agentic
			? { model: agent, route: "agent", reason: d.reason ? `auto: ${d.reason}` : "auto: agentic" }
			: {
					model: selected,
					route: "selected",
					reason: d?.reason ? `auto: ${d.reason}` : "auto: direct",
				};
	} catch (err) {
		const reason = classifyRouteFailure(err);
		routeFailureCount++;
		logger.warn({ err, reason }, "[agent-route] /route failed; answering normally");
		return { model: selected, route: "selected", reason: `auto: route error (${reason})`, failed: true };
	}
}

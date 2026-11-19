// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface RequestContext {
	requestId: string;
	url?: string;
	user?: string;
	statusCode?: number;
	/** local-only flag-value overrides for the fuzzing harness, parsed from the `fuzz_override`
	 *  cookie in hooks/handle.ts. Lets flags.ts's SYNC deployment-level reads (flagEnabledOr) see a
	 *  per-request override despite taking no request parameter of their own — the alternative would be
	 *  threading a new parameter through every call site in the app for a capability real users never
	 *  exercise. Always undefined unless flags.ts's fuzzOverrideEnabled gate is on. */
	fuzzOverride?: Record<string, boolean>;
	/** Every flag evaluated for the signed-in account, set by hooks/handle.ts after
	 *  authentication. flags.ts's `flagEnabledOr` reads it ahead of the deployment snapshot. Undefined
	 *  for a signed-out visitor or when the account's evaluation failed. */
	accountFlags?: ReadonlyMap<string, boolean>;
	/** The layer test's per-request switches, behind the same gate (see evalLayers.ts). */
	evalLayers?: import("$lib/chat/server/evalLayers").EvalLayers;
	/** The switches the turn actually applied, reported on its finished update. */
	evalLayersApplied?: import("$lib/chat/server/evalLayers").AppliedEvalLayers;
	/** Hugging Face Hub calls this request made, by kind, counted by storage/hubFetch.ts. */
	hubCalls?: Record<string, number>;
	/** How many of those Hub calls answered 429. */
	hubThrottled?: number;
	/** The model replay mode this request's scenario run asked for (faultInjection.ts's
	 *  resolveReplayMode), read by every model call the turn makes: the answer, its side calls through
	 *  endpointOai.ts, and the SDK clients openaiClient.ts builds. Undefined on any request without the
	 *  fault-inject token. */
	replayMode?: import("$lib/chat/server/endpoints/openai/modelReplay").ReplayMode;
	/** A `@real-screen` spec on a develop push, nightly or promotion run asked for the live guard
	 *  (faultInjection.ts's resolveGuardLive), so detectors/shieldstral.ts calls it live and records over
	 *  a stored verdict that shieldstral.ts's guardRefreshDue marks due, off-peak. Undefined
	 *  on any request without the fault-inject token. */
	guardLive?: boolean;
	/** This send asked for the in-process stand-in for agent-service (faultInjection.ts's
	 *  resolveFakeAgent), read by endpointAgent.ts when it submits a new task. Undefined on any request
	 *  without the fault-inject token. */
	fakeAgent?: import("$lib/chat/server/endpoints/agent/fakeAgentService").FakeAgentRequest;
	/** This send asked for the `history_mac_key_rotated` fault, read by sealedTurn.ts's macRing, so the
	 *  turn checks and writes MACs as a deployment does after its MAC key is rotated. Undefined on any
	 *  request without the fault-inject token. */
	macKeyRotated?: boolean;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Run a function within a request context.
 * All logs within this context will automatically include the requestId.
 */
export function runWithRequestContext<T>(
	fn: () => T,
	context: Partial<RequestContext> & { requestId?: string } = {}
): T {
	const fullContext: RequestContext = {
		requestId: context.requestId ?? randomUUID(),
		url: context.url,
		user: context.user,
		statusCode: context.statusCode,
		fuzzOverride: context.fuzzOverride,
		evalLayers: context.evalLayers,
	};
	return asyncLocalStorage.run(fullContext, fn);
}

/**
 * Update the current request context with additional information.
 * Useful for adding user information after authentication.
 */
export function updateRequestContext(updates: Partial<Omit<RequestContext, "requestId">>): void {
	const store = asyncLocalStorage.getStore();
	if (store) {
		Object.assign(store, updates);
	}
}

/**
 * Run `fn` as the deployment, not as the current request: the same context with its `fuzzOverride` and
 * `accountFlags` removed. For anything built once and shared by every visitor (a spec's
 * `agent-mode: false` cookie on a warm request would otherwise rebuild the registry without the agent for all).
 */
export function runAsDeployment<T>(fn: () => T): T {
	const store = asyncLocalStorage.getStore();
	if (!store) return fn();
	return asyncLocalStorage.run({ ...store, fuzzOverride: undefined, accountFlags: undefined }, fn);
}

/**
 * Get the current request context, if any.
 */
export function getRequestContext(): RequestContext | undefined {
	return asyncLocalStorage.getStore();
}

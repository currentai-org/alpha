// The feature gates the model registry reads while it builds, and the ONE refresh that makes them
// readable.
//
// ── Why these live together ──────────────────────────────────────────────────────────────────────
// The Omni router alias, the agent model and the side-call lane are unrelated features, but
// they are asked the same question at the same instant: `buildModelsFromCatalog` decides, once, what
// the registry contains. Co-locating them is not tidiness — it is what makes `resolveRegistryGates`
// the only way to get an answer, and that is the fix for the wrinkle below.
//
// ── THE WRINKLE: the registry builds ONCE per instance ───────────────────────────────────────────
// Gates read a flag SNAPSHOT refreshed by the warm cron. On a cold instance that snapshot is still
// empty when the registry builds — ALWAYS in preview, which has no cron, and briefly in prod on a cold
// start. A gate read then returns its fallback (off) and the instance caches that answer for its whole
// life, so the flag looks broken rather than off. `maybeAddAgentModel` already solved this by calling
// `refreshFlags()` at build time; both new gates need the same treatment.
//
// Repeating that call per gate is how it drifts. So the refresh moved HERE, in front of all three:
// `resolveRegistryGates` is the sole producer of a `RegistryGates`, and it cannot produce one without
// awaiting the poll first. A future gate added to that function inherits the fix; a future gate that
// reads a flag directly during the build does not, which is the one thing to watch for.
//
// ── The env var is config; the flag is the switch ────────────────────────────────────────────────
// The router alias gate exists because an env var was doing a flag's job: LLM_ROUTER_ROUTES_PATH
// names WHERE the routing policy lives. Its non-emptiness was the alias's on/off switch, so the policy
// could not be present with the feature off — and the alias lands at models[0], taking the picker
// default with it.
//
// MODEL_ALLOWLIST (and config/picker.ts) alone decide which models the picker offers. The
// `model-picker` flag that once narrowed the registry to the allowlist's first entry was
// retired once it was on everywhere.
//
// Every gate here falls back OFF, like every rollout gate (kill switches such as
// `crisis-referral-order` fall back ON). A deployment that never reaches PostHog gets no alias.

import { agentModeEnabled } from "$lib/chat/server/agentMode";
import { config } from "$lib/chat/server/config";
import { flagEnabledOr, refreshFlags, whenFlagsPolled } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { runAsDeployment } from "$lib/chat/server/requestContext";
import { runInBackground } from "$lib/chat/server/vercelBackground";

/** PostHog flag key. Owner: chat. Named for the code, not for `PUBLIC_LLM_ROUTER_DISPLAY_NAME` — that
 *  string is configurable, so a key called `omni` would go stale the day someone renames the alias. */
export const ROUTER_ALIAS_FLAG = "router-alias";

/** The configured routing-policy file, or "" — a path, NOT a feature gate. */
export function routerRoutesPath(): string {
	return ((Reflect.get(config, "LLM_ROUTER_ROUTES_PATH") as string | undefined) ?? "").trim();
}

/**
 * Should the Omni router alias be prepended to the registry? Fallback OFF.
 *
 * Flag ON with no `LLM_ROUTER_ROUTES_PATH` is a MISCONFIGURATION, not a silent off: the flag opened a
 * feature with no policy to route by. Say so and withhold the alias, exactly as `agentModeEnabled`
 * does for a missing `AGENT_SERVICE_URL` — never let a blank env var quietly mask a flagged-on feature,
 * which is the anti-pattern this whole change removes.
 */
export function routerAliasEnabled(): boolean {
	if (!flagEnabledOr(ROUTER_ALIAS_FLAG, () => false)) return false;
	if (!routerRoutesPath()) {
		logger.warn(
			"[models] router-alias flag is ON but LLM_ROUTER_ROUTES_PATH is unset — the Omni alias is withheld (config error, not a feature toggle)"
		);
		return false;
	}
	return true;
}

/** PostHog flag key. Owner: chat. Release condition `env exact preview` first; production waits on the
 *  privacy notice naming Mistral for side calls. */
export const SIDE_CALL_OWN_LANE_FLAG = "side-call-own-lane";

/** What the registry build needs to know, answered together against one fresh poll. */
export type RegistryGates = {
	/** Prepend the Omni router alias at models[0]. */
	routerAlias: boolean;
	/** Append the Potluck agent model. */
	agent: boolean;
	/** Register a side-call model that Mistral serves on the Mistral lane, not the compare endpoint. */
	sideCallLane: boolean;
};

let firstPollLogged = false;

/** How long a registry build waits on its flag poll before reading what it has.
 *  @internal exported for its unit tests */
export const REGISTRY_POLL_CAP_MS = 3000;

let onLatePoll: (() => unknown) | undefined;
let latePollPending = false;
/** The rebuild the last flag-bearing poll started, so the instance stays awake until it finishes. */
let lateRebuild: Promise<unknown> = Promise.resolve();

/** Run `fn` once a poll returns flags, when a registry build read its gates before one had (models.ts registers its rebuild). */
export function onRegistryPollLanded(fn: () => unknown): void {
	onLatePoll = fn;
}

/**
 * Poll PostHog fresh, THEN answer every registry gate.
 *
 * The order is the point — see the wrinkle in the header. One extra poll per instance's first registry
 * build, off the hot path (the registry is memoised), and `routerAlias`/`sideCallLane` each read a live
 * value instead of a cold-start empty snapshot. `refreshFlags` swallows its own failures, so an
 * unreachable PostHog leaves those fallbacks in effect rather than throwing out of the top-level await
 * and 500ing every route. `agent` depends on the poll again as — it reads the `agent-mode`
 * flag from the same snapshot, so the cold-start-reads-its-fallback wrinkle applies to every gate. It kept its own `deployEnv` short-circuit, which is why a local or
 * test env answers `agent: false` without reading a flag at all.
 */
export async function resolveRegistryGates(): Promise<RegistryGates> {
	const pollStart = Date.now();
	// The first call on an instance sits on a cold request's path, so its wait is a boot stage
	// and every request routed to the instance waits with it. Capped: past the cap the gates
	// read the last known values or their fallbacks, and the poll finishes in the background. Later
	// calls come from the warm cron every ~60s and are not logged.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = refreshFlags();
	// Vercel freezes an instance between invocations, and a frozen instance runs neither this poll nor the
	// rebuild that waits on it, so the registry
	// keeps one model until a later request thaws the instance. Hold the instance open until the poll
	// lands and any rebuild it starts has finished. Not awaited, so the cap below still bounds the build.
	void runInBackground(poll.then(() => lateRebuild));
	await Promise.race([
		poll,
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, REGISTRY_POLL_CAP_MS);
		}),
	]);
	clearTimeout(timer);
	// Gates read before any poll has returned flags are fallbacks, and the registry built from them would
	// keep them. That covers a poll past the cap and one that came back empty inside it, because the
	// definitions hadn't loaded yet. Once a poll returns flags, tell the registry so it re-reads the
	// gates and rebuilds if any changed. One waiter per instance is enough.
	if (!latePollPending) {
		latePollPending = whenFlagsPolled(() => {
			latePollPending = false;
			lateRebuild = Promise.resolve(onLatePoll?.());
			return lateRebuild;
		});
	}
	if (!firstPollLogged) {
		firstPollLogged = true;
		logger.info(
			{ leg: "boot", stage: "registry-flag-poll", ms: Date.now() - pollStart },
			"[boot] stage timing"
		);
	}
	// Read as the deployment: the registry is shared, so one request's override cookie must not set it.
	return runAsDeployment(() => ({
		routerAlias: routerAliasEnabled(),
		agent: agentModeEnabled(),
		sideCallLane: flagEnabledOr(SIDE_CALL_OWN_LANE_FLAG, () => false),
	}));
}

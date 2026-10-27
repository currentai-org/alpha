// The three feature gates the model registry reads while it builds, and the ONE refresh that makes
// them readable (CUR-245, CUR-257).
//
// ── Why these live together ──────────────────────────────────────────────────────────────────────
// The picker's breadth, the Omni router alias and the agent model are three unrelated features, but
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
// Both new gates exist because an env var was doing a flag's job:
//
//   MODEL_ALLOWLIST names WHICH models the picker offers. It could not say whether to offer a picker
//   at all — widening the string was itself the rollout, landing on everyone at the next deploy with
//   no fraction and no way back but another deploy. The per-model vetting in CUR-245 is now the
//   condition for turning the flag ON, not a blocker on merging the code.
//
//   LLM_ROUTER_ROUTES_PATH names WHERE the routing policy lives. It is config, not the alias's on/off
//   switch: the policy can be present with the feature off, and the alias lands at models[0], taking
//   the picker default with it, so the flag alone decides.
//
// Both fall back OFF, like every rollout gate (kill switches fall back ON). A deployment that never reaches
// PostHog serves one model and no alias.

import { agentModeEnabled } from "$lib/chat/server/agentMode";
import { config } from "$lib/chat/server/config";
import { flagEnabledOr, refreshFlags, whenFlagsPolled } from "$lib/chat/server/flags";
import { logger } from "$lib/chat/server/logger";
import { runAsDeployment } from "$lib/chat/server/requestContext";
import { runInBackground } from "$lib/chat/server/vercelBackground";

/** PostHog flag key. Owner: chat. Release condition `env exact preview` until the per-model vetting in
 *  CUR-245 is done — a flag with no env condition is on in prod the moment it is on anywhere. */
export const MODEL_PICKER_FLAG = "model-picker";

/** PostHog flag key. Owner: chat. Named for the code, not for `PUBLIC_LLM_ROUTER_DISPLAY_NAME` — that
 *  string is configurable, so a key called `omni` would go stale the day someone renames the alias. */
export const ROUTER_ALIAS_FLAG = "router-alias";

/** The configured routing-policy file, or "" — a path, NOT a feature gate. */
export function routerRoutesPath(): string {
	return ((Reflect.get(config, "LLM_ROUTER_ROUTES_PATH") as string | undefined) ?? "").trim();
}

/**
 * Should the registry offer more than the default model? Fallback OFF.
 *
 * OFF does not mean "no models" — it means the allowlist's FIRST entry alone, which is what
 * `defaultModel` already is. So prod, whose allowlist has one entry, is unchanged either way, and a
 * widened `MODEL_ALLOWLIST` sits inert until the flag opens it.
 */
export function modelPickerEnabled(): boolean {
	return flagEnabledOr(MODEL_PICKER_FLAG, () => false);
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
 *  privacy notice naming Mistral for side calls (CUR-2063). */
export const SIDE_CALL_OWN_LANE_FLAG = "side-call-own-lane";

/** What the registry build needs to know, answered together against one fresh poll. */
export type RegistryGates = {
	/** Offer every allowlisted model, rather than the first one alone. */
	picker: boolean;
	/** Prepend the Omni router alias at models[0]. */
	routerAlias: boolean;
	/** Append the Potluck agent model. */
	agent: boolean;
	/** Register a side-call model that Mistral serves on the Mistral lane, not the compare endpoint (CUR-2262). */
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
 * build, off the hot path (the registry is memoised), and `picker`/`routerAlias` each read a live value
 * instead of a cold-start empty snapshot. `refreshFlags` swallows its own failures, so an unreachable
 * PostHog leaves those two fallbacks in effect rather than throwing out of the top-level await and
 * 500ing every route. `agent` reads the `agent-mode` flag from the same snapshot (CUR-1440), so the
 * cold-start-reads-its-fallback wrinkle applies to all three gates. It keeps its own `deployEnv()` short-circuit, which is why a local or
 * test env answers `agent: false` without reading a flag at all.
 */
export async function resolveRegistryGates(): Promise<RegistryGates> {
	const pollStart = Date.now();
	// The first call on an instance sits on a cold request's path, so its wait is a boot stage
	// (CUR-2371) and every request routed to the instance waits with it. Capped: past the cap the gates
	// read the last known values or their fallbacks, and the poll finishes in the background. Later
	// calls come from the warm cron every ~60s and are not logged.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = refreshFlags();
	// Vercel freezes an instance between invocations, and a frozen instance runs neither this poll nor the
	// rebuild that waits on it, so the registry
	// keeps one model until a later request thaws the instance (CUR-4194). Hold the instance open until the poll
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
		picker: modelPickerEnabled(),
		routerAlias: routerAliasEnabled(),
		agent: agentModeEnabled(),
		sideCallLane: flagEnabledOr(SIDE_CALL_OWN_LANE_FLAG, () => false),
	}));
}

/**
 * Narrow an allowlisted catalog to what the picker actually offers.
 *
 * Truncating AFTER `selectAllowedModels` rather than rewriting the allowlist spec is deliberate: the
 * spec accepts `*`/`all`, which has no first entry until the catalog is resolved. Keeping `[0]` means
 * `defaultModel` is the same model with the flag either way — and sixteen consumers read
 * `MODEL_ALLOWLIST[0]` as the model under test (CUR-243), so it must not move with a flag flip.
 */
export function offeredModels<T>(allowed: T[], pickerOn: boolean): T[] {
	return pickerOn ? allowed : allowed.slice(0, 1);
}

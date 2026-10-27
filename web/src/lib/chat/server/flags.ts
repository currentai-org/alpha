// Server-side feature flags (CUR-86). The plane that owns ROLLOUT and VISIBILITY — "should this be
// on, and for whom" — as distinct from Doppler env, which owns secrets and SAFETY gates. The split is
// by what a flag DOES, not by which system has nicer ergonomics: a flag service being unreachable and
// defaulting moderation off is a worse failure than config drift, so OUTPUT_MODERATION /
// COOP_BLOCK_ACTIONS stay in env, local and fail-closed, and never come here.
//
// Why not just env vars: they are not a fast lever (CUR-61). `config` reads $env/dynamic/private,
// which is runtime-READ, but a Lambda's process.env is fixed by the deployment's function
// configuration at deploy time. Runtime-read is not runtime-SETTABLE: a Doppler sync does not reach
// the running deployment until it is redeployed. So flipping an env var costs a full redeploy, and
// percentage rollout is impossible.
//
// ── Why a SNAPSHOT rather than awaiting the SDK ────────────────────────────────────────────────
// posthog-node's isFeatureEnabled() is async even under local evaluation. Every existing gate here is
// SYNC — `ragEnabled()`, and `WORLD_MODEL_PREPASS` is a module-level const evaluated at import — so
// awaiting at the read site would ripple through call sites for no behavioural gain. Instead the warm
// cron (running every 60s) refreshes a snapshot, and reads are sync map lookups. Cost: up to ~60s of
// staleness, against a redeploy for an env var.
//
// ── Fallback posture, which is the part that matters ──────────────────────────────────────────
// A flag read must NEVER be the reason something breaks. Three states, deliberately different:
//   1. Never polled successfully (no key, PostHog down at boot, cold start) → the ENV value, so an
//      unconfigured deploy behaves as if this module didn't exist.
//   2. Polled, then PostHog became unreachable → the LAST KNOWN value, not the env value. Reverting
//      to the env value would silently flip behaviour at the worst possible moment; going stale is the
//      lesser failure and the one an operator can reason about.
//   3. Polled and fresh → PostHog's value.
// Anything numeric must additionally be clamped at the read site: a knob changeable without a PR can
// set GENERATION_TIMEOUT_MS to a value that breaks the deadline ladder with no code review, and
// PostHog makes that faster, not safer (CUR-45).
//
// A flag nobody removes is worse than no flag. Each one gets an owner and an expected end date, or it
// is permanent config and belongs in Doppler. Every key the server reads is declared in flagKeys.ts,
// and refreshFlags reconciles that list against what PostHog actually returns — so a key that was
// renamed, deleted, or never created cannot stay invisible behind a fallback of `false`.

import { createHash } from "node:crypto";
import { config } from "$lib/chat/server/config";
import { hmacSha256, timingSafeEqual } from "$lib/chat/server/crypto";
import { deployEnv, isTestDeployment } from "$lib/chat/server/deployEnv";
import { bakedCacheProvider, bakedFlagDefinitions } from "$lib/chat/server/flagDefinitionsBaked";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { deploymentInstance } from "$lib/chat/server/instance";
import { DEPLOYMENT_SCOPED_FLAG_KEYS, FLAG_KEYS, FLAG_KEY_NAMES } from "$lib/chat/server/flagKeys";
import { logger } from "$lib/chat/server/logger";
import { serverPosthogHost } from "$lib/chat/server/posthogHost";
import { getRequestContext } from "$lib/chat/server/requestContext";

/** Read a raw env value through the config proxy. Reflect.get because these keys are deploy-only and
 *  not in the committed .env — the ConfigProxy typecheck would reject a direct read (same pattern as
 *  rag/env.ts). */
function env(key: string): string {
	return ((Reflect.get(config, key) as string | undefined) || "").trim();
}

function envBool(key: string): boolean {
	return env(key).toLowerCase() === "true";
}

// ── Local fuzzing-harness override (CUR-1044) ───────────────────────────────────────────────────────
// The local per-flag Playwright/Stagehand harness needs to force a specific flag on/off for a browser
// session without touching live PostHog config. Deliberately NOT a bootstrap/localStorage/query-param
// mechanism a real visitor could ever hit: gated OFF in production unconditionally, in code, and even
// in non-production requires an explicit opt-in env var — a stray `fuzz_override` cookie does nothing
// unless BOTH are true. Two read paths honour it: `flagEnabledOr` (which `flagEnabled` delegates to)
// and `flagEnabledForUser`.
//
// Both must, because agent mode has two gates: `agentModeEnabled()` reads AGENT_MODE_FLAG through
// `flagEnabledOr`, and `agentModeEnabledForUser()` reads AGENT_MODE_ACCESS_FLAG through
// `flagEnabledForUser`. With only the first honouring the override, an override request turns agent
// mode on deployment-wide and is still refused per-account, so the A7 journey cannot be exercised.
//
// The override never changes what a production visitor gets: a fuzz-override request needs a
// non-production deployment, FUZZ_OVERRIDE_ENABLED set and the cookie present, and
// `fuzzOverrideEnabled()` short-circuits unless the deployment declares itself preview or development
// (`isTestDeployment`, CUR-1881).
export function fuzzOverrideEnabled(): boolean {
	return isTestDeployment() && envBool("FUZZ_OVERRIDE_ENABLED");
}

/** The cookie that proves a `fuzz_override` came from our harness, on a hosted preview. */
export const FUZZ_OVERRIDE_KEY_COOKIE = "fuzz_override_key";
const FUZZ_OVERRIDE_KEY_LABEL = "fuzz-override-key-v1";

/**
 * Whether this request may apply its `fuzz_override` and `eval_layers` cookies (CUR-3516).
 *
 * `fuzzOverrideEnabled()` decides per deployment, and preview has it on so the scenario suite can force
 * flags, which would let any anonymous visitor to develop force them too. On anything but local
 * server the request must also carry `fuzz_override_key` holding `E2E_OTP_BYPASS_TOKEN`, compared
 * as HMAC digests the way `otpSendCapCarveOut` compares it. No token configured means no request
 * qualifies.
 */
export async function fuzzOverrideAuthorized(suppliedKey: string | undefined): Promise<boolean> {
	if (!fuzzOverrideEnabled()) return false;
	// Local servers declare `development` (Doppler's dev config sets DEPLOY_ENV). The Dev flags dialog
	// runs there and carries no key. An undeclared deployment never gets this far (CUR-1881).
	if (deployEnv() === "development") return true;
	const token = config.E2E_OTP_BYPASS_TOKEN;
	if (!token || !suppliedKey) return false;
	const [supplied, expected] = await Promise.all([
		hmacSha256(FUZZ_OVERRIDE_KEY_LABEL, suppliedKey),
		hmacSha256(FUZZ_OVERRIDE_KEY_LABEL, token),
	]);
	return timingSafeEqual(supplied, expected);
}

/** This request's `fuzz_override` value for `key`: undefined unless overrides are enabled here (never in
 *  production) and the request carries one for it. */
export function fuzzOverrideValue(key: string): boolean | undefined {
	if (!fuzzOverrideEnabled()) return undefined;
	return getRequestContext()?.fuzzOverride?.[key];
}

/** The last successfully-polled flag values. Empty until the first successful refresh — which is the
 *  difference between state 1 and state 2 above, so `polledOk` is tracked separately rather than
 *  inferred from size (a project with zero flags polls fine and returns nothing). */
const snapshot = new Map<string, boolean>();
let polledOk = false;
let lastRefreshAt = 0;
/** Registry keys already reported absent. See reportMissingKeys — this is what makes the warning
 *  once-per-process rather than once-per-refresh. */
const warnedMissingKeys = new Set<string>();

/** One-shot callbacks waiting on the first successful poll. See whenFlagsPolled. */
const firstPollWaiters: Array<() => unknown> = [];

/**
 * Run `fn` once, after the first poll that returns flags, and return true; return false and do nothing
 * when one already has. A value read before then is a fallback, and a cold poll can come back empty
 * well inside any cap because the SDK's definitions haven't loaded yet, so a caller that keeps what it
 * read (the model registry) needs this rather than the poll's own settling (CUR-4194).
 */
export function whenFlagsPolled(fn: () => unknown): boolean {
	if (polledOk) return false;
	firstPollWaiters.push(fn);
	return true;
}

/** Exposed for tests — never for control flow. */
export function flagsDebugState(): { polledOk: boolean; lastRefreshAt: number; size: number } {
	return { polledOk, lastRefreshAt, size: snapshot.size };
}

/** Reset module state. TESTS ONLY. */
export function __resetFlagsForTest(): void {
	snapshot.clear();
	polledOk = false;
	firstPollWaiters.length = 0;
	lastRefreshAt = 0;
	warnedMissingKeys.clear();
	client = undefined;
	clientInitAttempted = false;
	localEvaluation = false;
	warnedRemoteKeys.clear();
	undefinedRemoteKeys.clear();
	pollInFlight = null;
	for (const store of [accounts, guests]) {
		store.cache.clear();
		store.inFlight.clear();
	}
}

/**
 * Is `key` on? SYNC, never throws, always answers.
 *
 * `envFallbackKey` is the env var this flag is migrating FROM. It is used when PostHog has never been
 * polled successfully, so an unconfigured deployment behaves exactly as it does today — the migration
 * has no flag-day. Pass the same key you would have read directly.
 */
export function flagEnabled(key: string, envFallbackKey: string): boolean {
	return flagEnabledOr(key, () => envBool(envFallbackKey));
}

/**
 * Same contract as `flagEnabled`, but the fallback is COMPUTED rather than read from a boolean env var.
 *
 * Needed because not every gate we're migrating from is a `"true"`/`"false"` string. `AGENT_SERVICE_URL`
 * is the clearest case: a URL whose NON-EMPTINESS doubles as the feature gate (CUR-87), so the current
 * behaviour it must fall back to is "is that URL set", not "is that env var the word true".
 *
 * `fallback` is a thunk, not a value, so it is only evaluated when actually needed — and so callers
 * can't accidentally freeze a config read at module-init time, which is the bug this whole plane exists
 * to avoid.
 */
export function flagEnabledOr(key: string, fallback: () => boolean): boolean {
	const override = fuzzOverrideValue(key);
	if (override !== undefined) return override;
	// A signed-in request reads its account's own answer first, unless the flag builds
	// something every visitor shares (flagKeys.ts, FlagScope). (CUR-2463)
	if (!DEPLOYMENT_SCOPED_FLAG_KEYS.has(key)) {
		const acct = getRequestContext()?.accountFlags?.get(key);
		if (acct !== undefined) return acct;
	}
	if (!polledOk) return fallback();
	const v = snapshot.get(key);
	// Polled, but PostHog doesn't define this flag: fall back rather than inventing `false`. A flag that
	// hasn't been created yet must not silently turn a feature off.
	return v === undefined ? fallback() : v;
}

// ── PostHog client ───────────────────────────────────────────────────────────────────────────────
// LOCAL evaluation when POSTHOG_FLAGS_SECRET_KEY (a project secret `phs_…`, read-only, scoped to flag
// definitions) is set; REMOTE evaluation on PUBLIC_POSTHOG_KEY alone otherwise. Never a personal `phx_…`
// key, which is tied to a person's account and inherits their permissions.
//
// Remote evaluation bills every `getAllFlags`, and the cost is per Lambda instance, not per
// deployment: each instance polls for the deployment and once per signed-in account every 60s, and
// scenario runs on PR previews start many short-lived instances, so remote evaluation can pass the
// free request allowance within days (PostHog billing, CUR-2897).
// Locally, `getAllFlags` costs nothing; the SDK polls `/flags/definitions` once per instance per
// FLAG_SNAPSHOT_MAX_AGE_MS, billed as 1 request when nothing changed (ETag, 304) and 10 when it did.
// A PR preview polls nothing at all: its definitions are baked at build (flagDefinitionsBaked.ts).
//
// Local evaluation only answers a condition on a property the call passes. Live conditions read `env`,
// `email` or `account_id` (PostHog's flag list), and the code also sends `instance` and
// `signed_in`, so `personPropertiesFor` passes all five, with "" for what this caller doesn't know. An unknown property would otherwise make the flag
// inconclusive, and with `onlyEvaluateLocally` it would drop out of the result and read its fallback.
// When a flag drops out anyway (a condition on a fourth property, a cohort), `evaluateFlags` asks
// PostHog for just those keys remotely and `warnRemoteFallback` names each one once per process, so a
// new condition costs billed requests and a log line, never a silent fallback. The authoring-time check
// is scripts/flag-class-audit.mjs.
//
// The consequence to keep in mind: a wrong/rotated key, a quota cutoff (the SDK clears its local flags
// on a 402) and a project with no flags ALL come back as an empty set. `refreshFlags` therefore treats
// "no flags returned" as a FAILED poll rather than an empty one. A credential problem must not look
// like a healthy empty project.

type MinimalPostHog = {
	getAllFlags(
		distinctId: string,
		options?: {
			personProperties?: Record<string, string | number | boolean>;
			onlyEvaluateLocally?: boolean;
			flagKeys?: string[];
		}
	): Promise<Record<string, boolean | string>>;
	waitForLocalEvaluationReady?(timeoutMs?: number): Promise<boolean>;
	isLocalEvaluationReady?(): boolean;
	reloadFeatureFlags?(): Promise<void>;
	getFeatureFlag(
		key: string,
		distinctId: string,
		options?: {
			personProperties?: Record<string, string | number | boolean>;
			onlyEvaluateLocally?: boolean;
			sendFeatureFlagEvents?: boolean;
		}
	): Promise<string | boolean | undefined>;
	shutdown(): Promise<void>;
};

let client: MinimalPostHog | undefined;
let clientInitAttempted = false;
/** True once the client was built with a secret key: every read then evaluates in-process. */
let localEvaluation = false;

/** The person properties every evaluation carries: all three that live conditions read, "" for the
 *  ones this caller doesn't know, so local evaluation is never inconclusive. See the header above. */
function personPropertiesFor(): Record<string, string> {
	return { env: flagEnvProperty(), instance: flagInstanceProperty(), account_id: "", signed_in: "", email: "" };
}

/** Keys local evaluation could not answer and remote evaluation filled in, warned once per process. */
const warnedRemoteKeys = new Set<string>();
/** Keys remote evaluation did not return either: not defined in PostHog. Asked once per process, then
 *  left to reportMissingKeys, so an undefined key doesn't cost a billed request every refresh. */
const undefinedRemoteKeys = new Set<string>();

function warnRemoteFallback(keys: string[]): void {
	const fresh = keys.filter((k) => !warnedRemoteKeys.has(k));
	if (!fresh.length) return;
	for (const k of fresh) warnedRemoteKeys.add(k);
	logger.warn(
		{ keys: fresh },
		"[flags] local evaluation could not answer these flags, so each is evaluated remotely (billed per call). Usually a condition on a property other than env, email or account_id, or a cohort: rewrite the condition, or pass the property from personPropertiesFor."
	);
}

const LOCAL_DEFINITIONS_WAIT_MS = 1500;

/**
 * Wait (bounded) for the definitions a cold instance fetches, and say whether they arrived.
 *
 * @remarks
 * posthog-node's local `getAllFlags` and `getFeatureFlag` both start with an uncapped
 * `await loadFeatureFlags()`, so the 1.5s wait alone bounds nothing: a slow or hung definitions fetch
 * holds the caller until it settles, and a cold instance stalled that way holds every request queued
 * behind it until the platform kills it. Until the definitions are
 * in, read nothing: the caller keeps its last known values or env fallbacks, and the SDK's own
 * poller keeps loading in the background.
 */
async function localDefinitionsReady(c: MinimalPostHog): Promise<boolean> {
	await c.waitForLocalEvaluationReady?.(LOCAL_DEFINITIONS_WAIT_MS);
	return c.isLocalEvaluationReady?.() ?? true;
}

/**
 * Every flag for one distinct id. Remote: one billed call. Local: in-process, then one remote call
 * scoped to the registry keys local evaluation left out (PostHog's own fallback, made visible). An
 * empty local result is returned as-is: definitions are missing or quota-cut, and a remote call would
 * fail the same way.
 */
async function evaluateFlags(
	c: MinimalPostHog,
	distinctId: string,
	personProperties: Record<string, string>
): Promise<Record<string, boolean | string>> {
	if (!localEvaluation) return c.getAllFlags(distinctId, { personProperties });
	if (!(await localDefinitionsReady(c))) return {};
	const local = await c.getAllFlags(distinctId, { personProperties, onlyEvaluateLocally: true });
	if (!Object.keys(local).length) return local;
	const missing = FLAG_KEY_NAMES.filter((k) => !(k in local) && !undefinedRemoteKeys.has(k));
	if (!missing.length) return local;
	const remote = await c.getAllFlags(distinctId, { personProperties, flagKeys: missing });
	for (const k of missing) if (!(k in remote)) undefinedRemoteKeys.add(k);
	warnRemoteFallback(missing.filter((k) => k in remote));
	return { ...local, ...remote };
}

/** The distinctId used for DEPLOYMENT-level evaluation. v1 flags are on/off for the whole deployment,
 *  not per-user: that is what CUR-87 needs (flip the Apertus version or the ACP transport without a
 *  deploy). Per-user targeting is a separate, necessarily-async read at the call site — deliberately
 *  out of scope here rather than half-built. A FIXED id keeps percentage rollouts deterministic
 *  instead of flapping between refreshes. */
const DEPLOYMENT_DISTINCT_ID = "aipotluck-server";

async function getClient(): Promise<MinimalPostHog | undefined> {
	if (clientInitAttempted) return client;
	clientInitAttempted = true;
	const projectKey = env("PUBLIC_POSTHOG_KEY");
	if (!projectKey) {
		logger.info("[flags] PUBLIC_POSTHOG_KEY unset — every flag reads its env fallback");
		return undefined;
	}
	try {
		const { PostHog } = await import("posthog-node");
		const secretKey = env("POSTHOG_FLAGS_SECRET_KEY");
		client = new PostHog(projectKey, {
			// NOT env("PUBLIC_POSTHOG_HOST"): that browser var may be a relative adblock-proxy path
			// (`/rs`) that makes getAllFlags return {} silently. See posthogHost.ts (CUR-87).
			host: serverPosthogHost(),
			...(secretKey
				? {
						secretKey,
						// The SDK's own definitions poller. A frozen Lambda's timer doesn't fire, so an
						// idle instance doesn't poll.
						featureFlagsPollingInterval: FLAG_SNAPSHOT_MAX_AGE_MS,
						...(bakedFlagDefinitions
							? { flagDefinitionCacheProvider: bakedCacheProvider(bakedFlagDefinitions) }
							: {}),
					}
				: // Remote evaluation: no poller, refresh is driven by the warm cron and ensureFlagsPolled.
					{ featureFlagsPollingInterval: 0 }),
			// This module never captures events; flags only.
			disableGeoip: true,
		}) as unknown as MinimalPostHog;
		localEvaluation = Boolean(secretKey);
		logger.info(
			{
				mode: !secretKey
					? "remote"
					: !bakedFlagDefinitions
						? "local-polled"
						: bakedFlagDefinitions.mode === "seed"
							? "local-seeded"
							: "local-baked",
				bakedAt: bakedFlagDefinitions?.bakedAt,
			},
			"[flags] PostHog client ready"
		);
		// A seeded client starts on the build's definitions (CUR-4199). Fetch live once the seed has
		// loaded, held open so a frozen instance can't park it, so a flag flipped since the build lands
		// on this instance now rather than at the poller's next tick.
		if (secretKey && bakedFlagDefinitions?.mode === "seed") {
			const c = client;
			void runInBackground(
				(async () => {
					await c.waitForLocalEvaluationReady?.(LOCAL_DEFINITIONS_WAIT_MS);
					await c.reloadFeatureFlags?.();
				})().catch(() => {})
			);
		}
		return client;
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[flags] PostHog client init failed — env fallbacks remain in effect"
		);
		return undefined;
	}
}

/**
 * Warn for any registry key PostHog did not return. Why this is needed at all is in flagKeys.ts: every
 * gate we ship falls back to OFF, so a key that was never created behaves exactly like one deliberately
 * turned off, and the feature is dark with nothing to read and no lever to flip.
 *
 * ONCE PER PROCESS, not once per refresh. The warm cron refreshes every 60s and this is a static config
 * fact that cannot change between ticks, so a per-minute line would be ~1,440/day of the same sentence. Vercel
 * instances are ephemeral, so cold starts re-warn and the signal still lands in any multi-hour Axiom
 * window.
 *
 * MEMBERSHIP, NOT TRUTH — the assumption the whole check rests on. `getAllFlags` RETURNS a flag
 * that evaluates false; it does not omit it. For example:
 *     env=production  {"apertus15":false,"agent-mode":false}
 *     env=preview     {"apertus15":false,"agent-mode":true}
 * `apertus15` matches no group for this distinctId (it requires a
 * `tester` property the deployment poll never sends) and still comes back as a key. Were it omitted,
 * `snapshot.has` would report a healthy flag missing on every prod tick — crying wolf on the most ordinary state a flag has, which is
 * how a warning gets filtered and takes the real ones with it. Re-run the probe before trusting this if
 * the SDK major version moves.
 */
function reportMissingKeys(): void {
	const missing = FLAG_KEY_NAMES.filter((k) => !snapshot.has(k) && !warnedMissingKeys.has(k));
	if (!missing.length) return;
	for (const k of missing) warnedMissingKeys.add(k);
	logger.warn(
		{
			missing,
			// Spelled out so the line answers "what is broken" without a trip to the repo.
			consequence: FLAG_KEYS.filter((f) => missing.includes(f.key)).map(
				(f) => `${f.key}: ${f.whenAbsent}`
			),
			definedInPostHog: snapshot.size,
		},
		// Says WHICH keys and defers the consequence to the per-key `consequence` field above, rather
		// than asserting one for all of them: most gates fall back to OFF, but a kill switch such as
		// `crisis-referral-order` falls back ON (flagKeys.ts, honestyStream.ts), and a line claiming OFF
		// for that key would tell an operator the opposite of what happens.
		"[flags] flag key(s) read by the code are not defined in PostHog — each gate falls back to what `consequence` says, with no lever to change it"
	);
}

/** The `env` person property every evaluation carries. See the comment in refreshFlags. */
function flagEnvProperty(): string {
	const resolvedEnv = deployEnv() ?? "development";
	return resolvedEnv === "development" ? "preview" : resolvedEnv;
}

/** The `instance` person property every evaluation carries: `www`, or an event instance's name
 *  (CUR-3156), so a flag can hold a condition for one event instance without touching www. */
function flagInstanceProperty(): string {
	return deploymentInstance(process.env);
}

/** Refresh the snapshot. Called from the warm cron. Best-effort: never throws, and a failure leaves
 *  the previous snapshot in place (state 2 above) rather than clearing it. */
export async function refreshFlags(): Promise<void> {
	try {
		const c = await getClient();
		if (!c) return;
		// Carry the deployment env as a person-property so a flag can register a feature on preview
		// deployments without touching prod (CUR-121: the agent model registers where `env == "preview"`,
		// then per-user surface gates keep it hidden from everyone but a cleared tester).
		// `deployEnv()` (CUR-208) reads DEPLOY_ENV then VERCEL_ENV and warns when neither names an
		// environment; "development" is the harmless placeholder for that undeclared case, so it still
		// fails closed rather than leaking a preview feature into a misconfigured prod deployment.
		//
		// A GENUINE local dev machine, though, deliberately sets DEPLOY_ENV=development rather than
		// leaving it unset (CUR-884) — and for that case we query PostHog AS preview (CUR-885): local
		// dev is earlier in the pipeline than preview, never real user traffic, and every flag scoped
		// `env == "preview"` should be testable on a laptop without a second targeting condition. This
		// doesn't reopen the prod-leak risk above: Vercel sets VERCEL_ENV on every real deployment, so
		// the undeclared/misconfigured case above is never the value being substituted here.
		// Local: evaluateFlags waits (bounded) for the definitions on a cold instance rather than reading
		// an empty set as a failed poll. Warm, that resolves at once.
		const all = await evaluateFlags(c, DEPLOYMENT_DISTINCT_ID, personPropertiesFor());
		const keys = Object.keys(all);
		if (!keys.length) {
			// Ambiguous by construction: an empty project, a wrong key, definitions not loaded yet and a
			// quota cutoff all look identical here. Treating it as a successful poll would silently pin
			// every flag to its env fallback while REPORTING healthy — so it is a failed poll, loudly.
			logger.warn(
				`[flags] PostHog returned no flags (${localEvaluation ? "local" : "remote"} evaluation) — an empty project, a wrong/rotated PUBLIC_POSTHOG_KEY or POSTHOG_FLAGS_SECRET_KEY, definitions not yet loaded and a quota cutoff look identical here. Last known values (or env fallbacks, if never polled) remain in effect.`
			);
			return;
		}
		snapshot.clear();
		for (const [k, v] of Object.entries(all)) snapshot.set(k, v === true || v === "true");
		polledOk = true;
		lastRefreshAt = Date.now();
		// After the poll settles, not inside it: a waiter may poll again itself.
		for (const fn of firstPollWaiters.splice(0)) void Promise.resolve().then(fn);
		// Only reachable on a SUCCESSFUL poll — the empty-result branch above returns before this, so an
		// unreachable PostHog can never be reported as "the key does not exist".
		reportMissingKeys();
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[flags] refresh failed (swallowed — last known values retained)"
		);
	}
}

/** In-flight poll, shared across concurrent cold requests on the same instance so N simultaneous
 *  turns cause one refreshFlags() call, not N. */
let pollInFlight: Promise<void> | null = null;

/** How old a polled snapshot may get before a request starts a background refresh: production's warm
 *  cron interval, so preview's flags go stale no faster than production's. */
export const FLAG_SNAPSHOT_MAX_AGE_MS = 60_000;

/**
 * CUR-853/958: block THIS turn on one poll if the snapshot has never been populated, instead of
 * silently reading every flag as its OFF fallback until the warm cron happens to reach this instance
 * — which, per modelGates.ts's own header comment, is ALWAYS the case on preview (no cron runs there
 * at all) and briefly true in prod on a cold start. `resolveRegistryGates` already does this for the
 * three model-registry gates by awaiting `refreshFlags()` before it reads them; this is the same
 * pattern for any other flag read on the per-request path, generalized rather than re-solved per gate.
 *
 * Once `polledOk` is true it never waits — a warm instance's request only starts a background
 * refresh when the snapshot is stale — so the wait is confined to the first flag-gated request
 * after a cold boot. Bounded so an unreachable PostHog
 * can't stall a turn indefinitely: `refreshFlags()` already swallows its own errors, so racing it
 * against a timeout is purely a LATENCY bound, not a correctness one — a slow poll keeps running in
 * the background and the NEXT turn on this instance benefits from it even if this one didn't wait.
 */
export async function ensureFlagsPolled(timeoutMs = 2000): Promise<void> {
	if (polledOk) {
		// Preview runs no cron, so without this a warm instance kept its first snapshot until
		// Vercel recycled it, and a flag created or flipped on develop never reached it. Refresh in the
		// background once the snapshot is older than the cron interval: this turn reads the last
		// snapshot, the next one reads the fresh one, and no request ever waits on it. (CUR-2610)
		if (!pollInFlight && Date.now() - lastRefreshAt > FLAG_SNAPSHOT_MAX_AGE_MS) {
			const ageMs = Date.now() - lastRefreshAt;
			pollInFlight = refreshFlags().finally(() => {
				pollInFlight = null;
				// A successful refresh logs nothing else, so without this no line shows a warm instance
				// re-polling, and CUR-2610's live check has nothing to read. At most once a minute per instance.
				logger.info({ leg: "flags-refresh", ageMs, polled: polledOk }, "[flags] background refresh");
			});
		}
		return;
	}
	if (!pollInFlight) {
		pollInFlight = refreshFlags().finally(() => {
			pollInFlight = null;
		});
	}
	const t0 = Date.now();
	await Promise.race([pollInFlight, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
	// What a cold instance's request actually waited. Logged only on this path, so a warm instance
	// never writes it; `polled: false` means the cap fired or PostHog failed (CUR-1959).
	logger.info(
		{ leg: "flags-poll", ms: Date.now() - t0, polled: polledOk, capMs: timeoutMs },
		"[flags] request waited on the first poll"
	);
}

// ── Per-ACCOUNT rollout values (CUR-2463) ─────────────────────────────────────────────────────────
// The snapshot above answers for one fixed id with only `env`, so a release condition on a person
// (`email` matches `@<team domain>$`) cannot match, so production could not turn a feature on for the
// team alone. This evaluates every flag once per signed-in account and puts the answers on the request
// context, where `flagEnabledOr` reads them ahead of the snapshot. No call site changes.
//
// Evaluated the same way as the snapshot (see the header). With a secret key it is in-process and free;
// without one it is one billed `getAllFlags` call per active account per FLAG_SNAPSHOT_MAX_AGE_MS per
// instance, made in the background after the account's first request.
//
// The person properties are `env`, `account_id`, `signed_in` and `email`, the same `email`
// agentModeEnabledForUser already sends on every signed-in page load, so a condition written the way
// `agent-mode-access`'s is (`email` matches `@<domain>$`) works on every flag. The address is passed
// inline for one evaluation; no person profile is created.
// The distinct id is the account id, never anything the request carries (CUR-1278, below). The one
// exception is the guest sign-in hint (`guestSignInFlagValues`), which decides copy and nothing else.

type AccountEntry = { values: ReadonlyMap<string, boolean>; at: number };

// One store per kind of subject, so guests asking for the sign-in hint (CUR-3015) never evict an
// account's answers. Bounded: one entry per recently active subject, oldest dropped first. The guest
// store is smaller because a guest is asked about only after a refused photo, and asks once.
type EvalStore = { cache: Map<string, AccountEntry>; inFlight: Map<string, Promise<AccountEntry | undefined>>; max: number };
const newStore = (max: number): EvalStore => ({ cache: new Map(), inFlight: new Map(), max });
const ACCOUNT_CACHE_MAX = 1000;
const GUEST_CACHE_MAX = 200;
const accounts = newStore(ACCOUNT_CACHE_MAX);
const guests = newStore(GUEST_CACHE_MAX);

async function evaluateFor(
	store: EvalStore,
	distinctId: string,
	personProperties: Record<string, string>
): Promise<AccountEntry | undefined> {
	const c = await getClient();
	if (!c) return undefined;
	try {
		// The caller's properties over personPropertiesFor's "" defaults, so local evaluation is never
		// inconclusive on a property this subject doesn't have.
		const all = await evaluateFlags(c, distinctId, { ...personPropertiesFor(), ...personProperties });
		// An empty answer is the same ambiguity refreshFlags refuses to read as healthy; keep the
		// snapshot in charge rather than pinning this subject to every flag's fallback.
		if (!Object.keys(all).length) return undefined;
		const values = new Map<string, boolean>();
		for (const [k, v] of Object.entries(all)) values.set(k, v === true || v === "true");
		const entry = { values, at: Date.now() };
		store.cache.delete(distinctId);
		store.cache.set(distinctId, entry);
		if (store.cache.size > store.max) {
			const oldest = store.cache.keys().next().value;
			if (oldest !== undefined) store.cache.delete(oldest);
		}
		return entry;
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e) },
			"[flags] per-account evaluation failed (this request reads the deployment snapshot)"
		);
		return undefined;
	}
}

function startEvaluationIn(
	store: EvalStore,
	distinctId: string,
	personProperties: () => Record<string, string>
): Promise<AccountEntry | undefined> {
	let p = store.inFlight.get(distinctId);
	if (!p) {
		p = evaluateFor(store, distinctId, personProperties()).finally(() => store.inFlight.delete(distinctId));
		store.inFlight.set(distinctId, p);
	}
	return p;
}

/** Cached values for `distinctId`, waiting up to `timeoutMs` only on its first read on this instance. */
async function valuesIn(
	store: EvalStore,
	distinctId: string,
	personProperties: () => Record<string, string>,
	timeoutMs: number
): Promise<ReadonlyMap<string, boolean> | undefined> {
	const cached = store.cache.get(distinctId);
	if (cached) {
		if (Date.now() - cached.at > FLAG_SNAPSHOT_MAX_AGE_MS) void startEvaluationIn(store, distinctId, personProperties);
		return cached.values;
	}
	const t0 = Date.now();
	const entry = await Promise.race([
		startEvaluationIn(store, distinctId, personProperties),
		new Promise<undefined>((resolve) => setTimeout(resolve, timeoutMs)),
	]);
	logger.info(
		{ leg: "flags-account", ms: Date.now() - t0, evaluated: entry !== undefined, capMs: timeoutMs },
		"[flags] first request for an account waited on its evaluation"
	);
	return entry?.values;
}

/**
 * This account's flag values, for hooks/handle.ts to put on the request context. Waits (up to
 * `timeoutMs`) only on an account's first request on this instance; after that it answers from the
 * cache and refreshes in the background once the entry is older than FLAG_SNAPSHOT_MAX_AGE_MS.
 * Undefined means "read the deployment snapshot", never "everything off".
 *
 * @param accountId `locals.user._id` as a string. Never a value the request supplies.
 */
export async function accountFlagValues(
	accountId: string,
	email: string | undefined,
	timeoutMs = 1500
): Promise<ReadonlyMap<string, boolean> | undefined> {
	// `account_id` repeats the distinct id as a property, so "these accounts only" is an ordinary
	// property condition evaluated from what this call sends, with no person profile behind it.
	// `signed_in` is what a rule for everyone who signs in is written against (CUR-3015): a guest's
	// sign-in hint is evaluated with it too, and a guest has no email to match.
	return valuesIn(
		accounts,
		accountId,
		() => ({
			env: flagEnvProperty(),
			instance: flagInstanceProperty(),
			account_id: accountId, signed_in: "true", ...(email ? { email } : {}) }),
		timeoutMs
	);
}

/**
 * What this guest would get once signed in (CUR-3015), for copy only: the sign-in hint on a refused
 * paste. Evaluated for the guest's own distinct id, so a percentage rollout buckets each guest rather
 * than one stand-in, with `signed_in` and no email, so a team-only rule says no and a rule for everyone
 * signed in says yes. A guess for the account they would sign in as, which PostHog buckets afresh.
 *
 * @param sessionId `locals.sessionId`, server-issued. Hashed before it leaves, never sent raw, and the
 *   answer gates no access, so the CUR-1278 rule on request-carried ids is not in play.
 */
export async function guestSignInFlagValues(
	sessionId: string,
	timeoutMs = 0
): Promise<ReadonlyMap<string, boolean> | undefined> {
	const distinctId = `guest-${createHash("sha256").update(`aipotluck-guest:${sessionId}`).digest("hex").slice(0, 32)}`;
	return valuesIn(guests, distinctId, () => ({ env: flagEnvProperty(), instance: flagInstanceProperty(), signed_in: "true" }), timeoutMs);
}

// ── Per-USER evaluation (CUR-121) ──────────────────────────────────────────────────────────────────
// Everything above is DEPLOYMENT-level: one fixed distinctId, a warm-cron snapshot, sync reads. This is
// the other axis — evaluate a flag for a SPECIFIC user, so a flag's release conditions can target one
// tester without every visitor getting it. Necessarily async (a live remote read), so it is NOT for the
// hot path of every request; callers gate it on a cheap identity check first (see agentModeEnabledForUser).
//
// No stored person profile: `personProperties` are passed INLINE for this one evaluation, which is the
// documented way to target anonymous users under `identified_only` without calling identify() (which
// would create a profile, change the distinctId, and expand processing — GDPR-minimal, CUR-121/CUR-116).

/**
 * Is `key` on for THIS user? Async; returns `undefined` when it could not be evaluated (no client, or
 * PostHog errored) so the caller decides the fallback — PostHog best-practice is "undefined = not
 * evaluated", never a silent `false`.
 *
 * `distinctId` MUST be the account's real id. It is the hash input that decides the answer, so a
 * synthetic one derived from anything the client supplies makes the flag answer a question about a
 * claim rather than about a person — see the CUR-1278 note below.
 * Currently uncalled: kept because it is the shape PostHog recommends, and deleting it invites the
 * next per-person gate to be reinvented the wrong way.
 *
 * `sendFeatureFlagEvents: false` is load-bearing, not incidental: it defaults TRUE and would enqueue a
 * `$feature_flag_called` capture on every call, breaking this module's "never captures events" invariant
 * (and adding flush/shutdown obligations on the request path). Local when a secret key is set, remote
 * otherwise, like every other read here.
 */
export async function flagEnabledForUser(
	key: string,
	distinctId: string,
	personProperties: Record<string, string | number | boolean>
): Promise<boolean | undefined> {
	// Ahead of the client check on purpose: an override must answer even when PostHog is unreachable
	// or unconfigured, which is the state a local harness run is usually in. Returning `undefined`
	// there would hand the caller its fallback instead of the value the harness asked for.
	const override = fuzzOverrideValue(key);
	if (override !== undefined) return override;
	const c = await getClient();
	if (!c) return undefined;
	try {
		// The caller's properties win; the defaults keep a condition on one it didn't pass conclusive.
		const props = { ...personPropertiesFor(), ...personProperties };
		if (localEvaluation && !(await localDefinitionsReady(c))) return undefined;
		let v = await c.getFeatureFlag(key, distinctId, {
			personProperties: props,
			...(localEvaluation ? { onlyEvaluateLocally: true } : {}),
			sendFeatureFlagEvents: false,
		});
		// Local evaluation couldn't answer: ask remotely, and say so (same rule as evaluateFlags).
		if (v === undefined && localEvaluation) {
			v = await c.getFeatureFlag(key, distinctId, { personProperties: props, sendFeatureFlagEvents: false });
			if (v !== undefined) warnRemoteFallback([key]);
		}
		return v === undefined ? undefined : v === true || v === "true";
	} catch (e) {
		logger.warn(
			{ err: e instanceof Error ? e.message : String(e), key },
			"[flags] per-user flag read failed — returning undefined (caller decides fallback)"
		);
		return undefined;
	}
}

// ── Do not rebuild the tester path (CUR-1278) ──────────────────────────────────────────────────────
// Do not add a flag read that takes a name the visitor typed (e.g. `?ph_test=<name>`) and passes
// `tester:<name>` to PostHog as the distinct id, with a roster mapping names to accounts. A distinct id
// names a PERSON: PostHog's model is that a flag result is a pure hash of (flag key, distinct id), so
// feeding it a string the client chose means the flag answers a question about whoever asked. No
// roster cross-check fixes that, it only makes the spoof harder, and a roster means keeping
// colleagues' names and account ids in this repo.
//
// What PostHog documents instead, and what any per-person gate here uses (the storage view, CUR-1276):
//
//   - Evaluate server-side with the REAL distinct id (the account's own id) and pass the properties
//     your own database already knows, inline, via `flagEnabledForUser` above. Their guidance is to
//     evaluate where the data lives rather than round-trip to look up what you sent them.
//   - Put the PERSON-SELECTION in the flag's own release conditions in PostHog, not in this repo:
//     `email ends with @<domain>` for the whole team (their docs specify `ends with` over `contains`,
//     which also matches lookalike domains), or pick individuals in the flag UI, whose value field
//     searches people by name or email so nobody pastes a raw id anywhere.
//   - Set the flag's evaluation runtime to server-only, which they recommend for sensitive rollouts,
//     so the client SDK never receives it.
//
// That leaves nothing here to hold a roster. `?ph_test=1` and `?ph_test=<label>` still work for
// marking internal traffic: analytics.ts reads the query string directly, client-side, and uses none
// of the above.

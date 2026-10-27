import { describe, it, expect, vi, beforeEach } from "vitest";

// flags.ts reads env through the `config` proxy and lazily imports posthog-node. Mock both so the
// fallback ladder can be driven without a network.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));
const warnMock = vi.fn();
const infoMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: infoMock, warn: warnMock } }));

const getAllFlags = vi.fn();
const getFeatureFlag = vi.fn();
const waitForLocalEvaluationReady = vi.fn(async () => true);
const isLocalEvaluationReady = vi.fn(() => true);
const reloadFeatureFlags = vi.fn(async () => {});
const constructed: Array<Record<string, unknown>> = [];
class FakePostHog {
	getAllFlags = getAllFlags;
	getFeatureFlag = getFeatureFlag;
	waitForLocalEvaluationReady = waitForLocalEvaluationReady;
	isLocalEvaluationReady = isLocalEvaluationReady;
	reloadFeatureFlags = reloadFeatureFlags;
	constructor(_key: string, opts: Record<string, unknown>) {
		constructed.push(opts);
	}
	async shutdown() {}
}
vi.mock("posthog-node", () => ({ PostHog: FakePostHog }));
// What the client asked to keep the instance awake for, so a spec can wait on it.
const held: Promise<unknown>[] = [];
vi.mock("$lib/chat/server/vercelBackground", () => ({
	runInBackground: vi.fn(async (p: Promise<unknown>) => {
		held.push(p);
	}),
}));
// A PR preview's build bakes definitions; every other build has none. `baked.data` switches between them.
const baked: {
	data: { flags: unknown[]; groupTypeMapping: object; cohorts: object; bakedAt?: string; mode?: string } | undefined;
} =
	{ data: undefined };
vi.mock("$lib/chat/server/flagDefinitionsBaked", async (orig) => {
	const real = await orig<typeof import("./flagDefinitionsBaked")>();
	return {
		bakedCacheProvider: real.bakedCacheProvider,
		get bakedFlagDefinitions() {
			return baked.data;
		},
	};
});

beforeEach(async () => {
	for (const k of Object.keys(cfg)) delete cfg[k];
	getAllFlags.mockReset();
	getFeatureFlag.mockReset();
	warnMock.mockReset();
	waitForLocalEvaluationReady.mockClear();
	isLocalEvaluationReady.mockReset().mockReturnValue(true);
	reloadFeatureFlags.mockClear();
	held.length = 0;
	constructed.length = 0;
	baked.data = undefined;
	const m = await import("./flags");
	m.__resetFlagsForTest();
});

const configured = () => {
	cfg.PUBLIC_POSTHOG_KEY = "phc_test";
};

describe("flagEnabled — the fallback ladder", () => {
	it("reads the ENV fallback when PostHog has never been polled (unconfigured deploy behaves as today)", async () => {
		cfg.WORLD_MODEL_PREPASS = "true";
		const { flagEnabled } = await import("./flags");
		expect(flagEnabled("world-model-prepass", "WORLD_MODEL_PREPASS")).toBe(true);
		cfg.WORLD_MODEL_PREPASS = "false";
		expect(flagEnabled("world-model-prepass", "WORLD_MODEL_PREPASS")).toBe(false);
	});

	it("prefers PostHog once polled, overriding the env value", async () => {
		configured();
		cfg.WORLD_MODEL_PREPASS = "false"; // env says off…
		getAllFlags.mockResolvedValue({ "world-model-prepass": true }); // …PostHog says on
		const { refreshFlags, flagEnabled } = await import("./flags");
		await refreshFlags();
		expect(flagEnabled("world-model-prepass", "WORLD_MODEL_PREPASS")).toBe(true);
	});

	// The state that matters when PostHog is unreachable: reverting to env would silently flip
	// behaviour at the worst moment. Going stale is the lesser failure.
	it("retains the LAST KNOWN value when a later refresh fails, rather than reverting to env", async () => {
		configured();
		cfg.COMPARE_PANEL_ENABLED = "false";
		getAllFlags.mockResolvedValue({ "compare-panel": true });
		const { refreshFlags, flagEnabled } = await import("./flags");
		await refreshFlags();
		expect(flagEnabled("compare-panel", "COMPARE_PANEL_ENABLED")).toBe(true);

		getAllFlags.mockRejectedValue(new Error("posthog unreachable"));
		await expect(refreshFlags()).resolves.toBeUndefined(); // best-effort
		expect(flagEnabled("compare-panel", "COMPARE_PANEL_ENABLED")).toBe(true); // still on, not env's false
	});

	it("falls back to env for a flag PostHog does not define, rather than inventing false", async () => {
		configured();
		cfg.RAG_ROUTER_SHADOW = "true";
		getAllFlags.mockResolvedValue({ "some-other-flag": true });
		const { refreshFlags, flagEnabled } = await import("./flags");
		await refreshFlags();
		// A flag that hasn't been created in PostHog yet must not silently turn the feature off.
		expect(flagEnabled("rag-router-shadow", "RAG_ROUTER_SHADOW")).toBe(true);
	});
});

describe("refreshFlags — credential and configuration failures must be loud", () => {
	it("does not poll at all without a project token, and says so", async () => {
		// no PUBLIC_POSTHOG_KEY
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).not.toHaveBeenCalled();
	});

	// An empty project and a wrong/rotated project token are INDISTINGUISHABLE here. Treating the
	// empty result as a successful poll would pin every flag to its env fallback while reporting
	// healthy — a check that cannot go red. It is a failed poll, loudly.
	it("treats an empty flag set as a FAILED poll, not a successful empty one", async () => {
		configured();
		cfg.WORLD_MODEL_PREPASS = "true";
		getAllFlags.mockResolvedValue({});
		const { refreshFlags, flagEnabled, flagsDebugState } = await import("./flags");
		await refreshFlags();
		expect(flagsDebugState().polledOk).toBe(false);
		expect(warnMock).toHaveBeenCalled();
		expect(String(warnMock.mock.calls[0]?.[0])).toContain("PUBLIC_POSTHOG_KEY");
		expect(flagEnabled("world-model-prepass", "WORLD_MODEL_PREPASS")).toBe(true); // env still governs
	});

	it("never throws when PostHog is unreachable", async () => {
		configured();
		getAllFlags.mockRejectedValue(new Error("ECONNREFUSED"));
		const { refreshFlags, flagsDebugState } = await import("./flags");
		await expect(refreshFlags()).resolves.toBeUndefined();
		expect(flagsDebugState().polledOk).toBe(false);
	});

	it("coerces PostHog's string variant values to booleans", async () => {
		configured();
		getAllFlags.mockResolvedValue({ a: "true", b: "control", c: true, d: false });
		const { refreshFlags, flagEnabled } = await import("./flags");
		await refreshFlags();
		expect(flagEnabled("a", "X")).toBe(true);
		expect(flagEnabled("b", "X")).toBe(false);
		expect(flagEnabled("c", "X")).toBe(true);
		expect(flagEnabled("d", "X")).toBe(false);
	});

	// The snapshot poll carries the deployment env as a person-property so a flag can register a feature
	// on preview only (CUR-121). Without it, an `env == "preview"` targeting group never matches the
	// server distinctId and the agent model never registers on develop.
	it("polls with the deployment env as a person-property", async () => {
		configured();
		vi.stubEnv("VERCEL_ENV", "preview");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});

	// Local dev deliberately sets DEPLOY_ENV=development so every `env == "preview"` flag is
	// testable on a laptop without a second targeting condition per flag. (CUR-885)
	it("queries PostHog as preview when DEPLOY_ENV is explicitly development", async () => {
		configured();
		vi.stubEnv("DEPLOY_ENV", "development");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});

	// The genuinely-unset case (deployEnv() returns null, not the string "development") must land on
	// the same substitution — a bare local machine with nothing set behaves like one that explicitly
	// opted into development.
	it("queries PostHog as preview when neither DEPLOY_ENV nor VERCEL_ENV is set", async () => {
		configured();
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});

	// An event instance shares www's flags (CUR-3156), and a flag tells them apart by
	// this property. Unset INSTANCE must read as www, so www's own evaluations are unchanged.
	it("polls with instance www when INSTANCE is unset, so www's conditions keep matching", async () => {
		configured();
		vi.stubEnv("DEPLOY_ENV", "production");
		vi.stubEnv("INSTANCE", "");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "production", instance: "www", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});

	it("polls with the event instance's name, so a flag can target instance = mozfest alone", async () => {
		configured();
		vi.stubEnv("DEPLOY_ENV", "production");
		vi.stubEnv("INSTANCE", "mozfest");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "production", instance: "mozfest", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});

	it("still queries PostHog as production when the deployment genuinely is production", async () => {
		configured();
		vi.stubEnv("DEPLOY_ENV", "production");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(getAllFlags).toHaveBeenCalledWith("aipotluck-server", {
			personProperties: { env: "production", instance: "www", account_id: "", signed_in: "", email: "" },
		});
		vi.unstubAllEnvs();
	});
});

describe("flagEnabledOr — computed fallback for gates that aren't boolean env vars", () => {
	it("uses the computed fallback when PostHog has never been polled", async () => {
		const { flagEnabledOr } = await import("./flags");
		expect(flagEnabledOr("agent-mode", () => true)).toBe(true);
		expect(flagEnabledOr("agent-mode", () => false)).toBe(false);
	});

	it("uses the computed fallback when polled but the flag is undefined in PostHog", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "some-other-flag": true });
		const { refreshFlags, flagEnabledOr, flagsDebugState } = await import("./flags");
		await refreshFlags();
		expect(flagsDebugState().polledOk).toBe(true);
		// A flag not yet CREATED must not read as `false` and silently turn the feature off.
		expect(flagEnabledOr("agent-mode", () => true)).toBe(true);
	});

	it("PostHog's value wins over the fallback once polled — both directions", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "agent-mode": false, other: true });
		const { refreshFlags, flagEnabledOr } = await import("./flags");
		await refreshFlags();
		expect(flagEnabledOr("agent-mode", () => true)).toBe(false); // off despite a true fallback
		expect(flagEnabledOr("other", () => false)).toBe(true); // on despite a false fallback
	});

	it("does not evaluate the fallback when PostHog defines the flag", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "agent-mode": true });
		const { refreshFlags, flagEnabledOr } = await import("./flags");
		await refreshFlags();
		const fallback = vi.fn(() => false);
		expect(flagEnabledOr("agent-mode", fallback)).toBe(true);
		// A thunk, not a value — so a caller can't freeze a config read at module-init time.
		expect(fallback).not.toHaveBeenCalled();
	});
});

// The distinct id here is an ACCOUNT id (24 hex, the shape `locals.user._id` carries) because
// that is the hash input PostHog decides the answer from. An id built from a string the visitor typed
// would make the flag answer a question about a claim rather than about a person. The id below is
// invented. (CUR-1278)
const ACCOUNT_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

describe("flagEnabledForUser — per-user evaluation (CUR-121)", () => {
	it("returns undefined (not false) when PostHog is unconfigured — caller decides the fallback", async () => {
		// no PUBLIC_POSTHOG_KEY → getClient() returns undefined, so the flag was NOT evaluated.
		const { flagEnabledForUser } = await import("./flags");
		await expect(
			flagEnabledForUser("agent-mode", ACCOUNT_ID, { is_internal_test: true })
		).resolves.toBeUndefined();
		expect(getFeatureFlag).not.toHaveBeenCalled();
	});

	it("forwards personProperties and disables event capture — must never emit $feature_flag_called", async () => {
		configured();
		getFeatureFlag.mockResolvedValue(true);
		const { flagEnabledForUser } = await import("./flags");
		const out = await flagEnabledForUser("agent-mode", ACCOUNT_ID, {
			env: "preview",
			is_internal_test: true,
		});
		expect(out).toBe(true);
		// sendFeatureFlagEvents:false is the invariant — this module never captures events.
		expect(getFeatureFlag).toHaveBeenCalledWith("agent-mode", ACCOUNT_ID, {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "", is_internal_test: true },
			sendFeatureFlagEvents: false,
		});
	});

	it("coerces the value, and maps an unknown flag to undefined — never a silent false", async () => {
		configured();
		const { flagEnabledForUser } = await import("./flags");
		getFeatureFlag.mockResolvedValue(false);
		await expect(flagEnabledForUser("k", "d", {})).resolves.toBe(false);
		getFeatureFlag.mockResolvedValue("true"); // string variant coerces
		await expect(flagEnabledForUser("k", "d", {})).resolves.toBe(true);
		getFeatureFlag.mockResolvedValue(undefined); // flag not created / not evaluated
		await expect(flagEnabledForUser("k", "d", {})).resolves.toBeUndefined();
	});

	it("returns undefined (never throws) when the read fails", async () => {
		configured();
		getFeatureFlag.mockRejectedValue(new Error("boom"));
		const { flagEnabledForUser } = await import("./flags");
		await expect(flagEnabledForUser("k", "d", {})).resolves.toBeUndefined();
	});
});

// `flagEnabledForTester` was removed along with the `?ph_test=<name>` identity it read.
// Named for what must stay gone rather than for what it does, because the failure this guards is
// someone rebuilding it: the mechanism had no callers, and it fed PostHog a distinct id assembled
// from a string the visitor typed. See the note in flags.ts for what to build instead. (CUR-1278)
describe("the self-declared tester path stays removed (CUR-1278)", () => {
	it("exports no tester-scoped evaluator", async () => {
		const mod = await import("./flags");
		expect(Object.keys(mod)).not.toContain("flagEnabledForTester");
	});

	it("never builds a distinct id out of a client-supplied string", async () => {
		configured();
		getFeatureFlag.mockResolvedValue(true);
		const { flagEnabledForUser } = await import("./flags");
		await flagEnabledForUser("some-dark-feature", ACCOUNT_ID, { is_internal_test: true });
		const [, distinctId] = getFeatureFlag.mock.calls[0] ?? [];
		expect(distinctId).toBe(ACCOUNT_ID);
		expect(String(distinctId)).not.toMatch(/^tester:/);
	});
});

// The failure these name: a key the code reads does not exist in PostHog, so its gate falls back to OFF
// and the feature is dark with no lever to open it and no line saying so.
//
// Note what is asserted: that the warning NAMES the absent key. "warns on a missing flag" would pass on
// a bare `logger.warn("something is wrong")`, which is the shape that leaves an operator no better off
// than silence. The expectations derive from FLAG_KEY_NAMES rather than hardcoding today's three, so
// adding a fourth gate does not make these red for the wrong reason.
describe("refreshFlags — a registered flag key missing from PostHog must be named, not swallowed", () => {
	const present = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, false]));
	const missingWarn = () =>
		warnMock.mock.calls.find((c) => String(c[1] ?? "").includes("not defined in PostHog"));

	it("names every registered key PostHog did not return, and what breaks for each", async () => {
		configured();
		const { FLAG_KEY_NAMES, FLAG_KEYS } = await import("./flagKeys");
		// Return only the FIRST registered key: the rest are absent and must be reported.
		getAllFlags.mockResolvedValue(present(FLAG_KEY_NAMES.slice(0, 1)));
		const { refreshFlags } = await import("./flags");
		await refreshFlags();

		const call = missingWarn();
		expect(call, "no warning fired — a missing flag key stayed invisible").toBeTruthy();
		expect(call![0].missing).toEqual(FLAG_KEY_NAMES.slice(1));
		// The consequence text is the part that makes the log line actionable on its own.
		expect(call![0].consequence).toEqual(
			FLAG_KEYS.slice(1).map((f) => `${f.key}: ${f.whenAbsent}`)
		);
	});

	it("stays silent when PostHog defines every registered key", async () => {
		configured();
		const { FLAG_KEY_NAMES } = await import("./flagKeys");
		getAllFlags.mockResolvedValue(present(FLAG_KEY_NAMES));
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(missingWarn(), "warned about a key PostHog actually defines").toBeUndefined();
	});

	// A flag PostHog defines as OFF is present in the snapshot. Reporting it as missing would cry wolf on
	// the single most normal state a flag can be in, and an operator who learns to ignore this line gets
	// nothing from it the day a key really is gone.
	it("does not confuse a flag that is defined-and-off with one that does not exist", async () => {
		configured();
		const { FLAG_KEY_NAMES } = await import("./flagKeys");
		getAllFlags.mockResolvedValue(Object.fromEntries(FLAG_KEY_NAMES.map((k) => [k, false])));
		const { refreshFlags, flagEnabledOr } = await import("./flags");
		await refreshFlags();
		expect(missingWarn()).toBeUndefined();
		expect(flagEnabledOr(FLAG_KEY_NAMES[0]!, () => true)).toBe(false); // defined-off beats the fallback
	});

	// Once per process, not once per 60s cron tick — see reportMissingKeys. Without this the same static
	// sentence lands ~1,440 times a day in Axiom.
	it("reports a given absent key once per process, however many times the cron refreshes", async () => {
		configured();
		const { FLAG_KEY_NAMES } = await import("./flagKeys");
		getAllFlags.mockResolvedValue(present(FLAG_KEY_NAMES.slice(0, 1)));
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		await refreshFlags();
		await refreshFlags();
		const calls = warnMock.mock.calls.filter((c) =>
			String(c[1] ?? "").includes("not defined in PostHog")
		);
		expect(calls).toHaveLength(1);
	});

	// An unreachable PostHog returns nothing, which must never be reported as "these keys don't exist" —
	// that would turn every PostHog failure into a false claim that features had been deleted.
	it("says nothing about missing keys when the poll itself failed", async () => {
		configured();
		getAllFlags.mockRejectedValue(new Error("ECONNREFUSED"));
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(missingWarn()).toBeUndefined();

		getAllFlags.mockResolvedValue({}); // empty result = failed poll (credential case), same rule
		await refreshFlags();
		expect(missingWarn()).toBeUndefined();
	});
});

// CUR-853/958: a cold instance's snapshot is empty until SOMETHING calls refreshFlags — the warm cron
// never runs at all on preview (modelGates.ts's own header comment), so a flag-gated turn served by a
// never-warmed instance silently read every flag as OFF. ensureFlagsPolled blocks the first read on one
// poll instead.
describe("ensureFlagsPolled — the cold-instance gap", () => {
	it("polls once when the snapshot has never been populated", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "arithmetic-guard": true });
		const { ensureFlagsPolled, flagEnabledOr } = await import("./flags");
		expect(flagEnabledOr("arithmetic-guard", () => false)).toBe(false); // cold: fallback
		await ensureFlagsPolled();
		expect(flagEnabledOr("arithmetic-guard", () => false)).toBe(true); // warm: real value
		expect(getAllFlags).toHaveBeenCalledTimes(1);
	});

	it("is a no-op once already polled — no extra network call on a warm instance's steady state", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "arithmetic-guard": true });
		const { ensureFlagsPolled, refreshFlags } = await import("./flags");
		await refreshFlags();
		await ensureFlagsPolled();
		await ensureFlagsPolled();
		expect(getAllFlags).toHaveBeenCalledTimes(1);
	});

	it("shares one in-flight poll across concurrent cold requests instead of firing N", async () => {
		configured();
		let resolvePoll: (v: Record<string, boolean>) => void = () => {};
		getAllFlags.mockReturnValue(new Promise((resolve) => (resolvePoll = resolve)));
		const { ensureFlagsPolled } = await import("./flags");
		const a = ensureFlagsPolled();
		const b = ensureFlagsPolled();
		resolvePoll({ "arithmetic-guard": true });
		await Promise.all([a, b]);
		expect(getAllFlags).toHaveBeenCalledTimes(1);
	});

	// Preview has no cron, so a warm instance's only chance to see a flag created or flipped
	// after its first poll is this path. (CUR-2610)
	it("refreshes a snapshot older than the cron interval in the background, without the request waiting on it", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "arithmetic-guard": false });
		const { ensureFlagsPolled, refreshFlags, flagEnabledOr, FLAG_SNAPSHOT_MAX_AGE_MS } = await import(
			"./flags"
		);
		const t0 = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		await refreshFlags();

		let resolvePoll: (v: Record<string, boolean>) => void = () => {};
		getAllFlags.mockReturnValue(new Promise((resolve) => (resolvePoll = resolve)));
		now.mockReturnValue(t0 + FLAG_SNAPSHOT_MAX_AGE_MS + 1);
		await ensureFlagsPolled(); // returns although the refresh it started has not answered
		await ensureFlagsPolled(); // shares that refresh rather than starting another
		expect(getAllFlags).toHaveBeenCalledTimes(2);
		expect(flagEnabledOr("arithmetic-guard", () => true)).toBe(false); // this turn: last snapshot

		resolvePoll({ "arithmetic-guard": true });
		await vi.waitFor(() => expect(flagEnabledOr("arithmetic-guard", () => false)).toBe(true));
		// The line a live check on develop reads to see a warm instance re-poll.
		await vi.waitFor(() =>
			expect(infoMock).toHaveBeenCalledWith(
				expect.objectContaining({ leg: "flags-refresh", polled: true }),
				"[flags] background refresh"
			)
		);
		now.mockRestore();
	});

	it("starts no refresh while the snapshot is younger than the cron interval", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "arithmetic-guard": true });
		const { ensureFlagsPolled, refreshFlags, FLAG_SNAPSHOT_MAX_AGE_MS } = await import("./flags");
		const t0 = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(t0);
		await refreshFlags();
		now.mockReturnValue(t0 + FLAG_SNAPSHOT_MAX_AGE_MS - 1);
		await ensureFlagsPolled();
		expect(getAllFlags).toHaveBeenCalledTimes(1);
		now.mockRestore();
	});

	it("gives up after its timeout without throwing, when PostHog never answers", async () => {
		configured();
		getAllFlags.mockReturnValue(new Promise(() => {})); // never resolves
		const { ensureFlagsPolled, flagsDebugState } = await import("./flags");
		await ensureFlagsPolled(10);
		expect(flagsDebugState().polledOk).toBe(false); // still cold — bounded, not faked
	});
});

// The local fuzzing harness forces a flag's value for its own Playwright/Stagehand session
// via a `fuzz_override` cookie parsed into the request context (see requestContext.ts, hooks/handle.ts).
// The one invariant that actually matters: this can NEVER take effect in production, however the env
// var or the request context are set. (CUR-1044)
describe("fuzz override (CUR-1044) — local-only, never reachable in production", () => {
	it("is inert in production even with the opt-in env var and a matching override set", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "production");
		getAllFlags.mockResolvedValue({ "some-flag": false });
		const { refreshFlags, flagEnabledOr } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		await refreshFlags();
		const result = runWithRequestContext(() => flagEnabledOr("some-flag", () => true), {
			fuzzOverride: { "some-flag": true },
		});
		expect(result).toBe(false); // PostHog's real value, not the override
		vi.unstubAllEnvs();
	});

	it("is inert on a deployment that declares no environment, even with the opt-in env var set (CUR-1881)", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "");
		vi.stubEnv("VERCEL_ENV", "");
		getAllFlags.mockResolvedValue({ "some-flag": false });
		const { refreshFlags, flagEnabledOr, fuzzOverrideEnabled } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		await refreshFlags();
		expect(fuzzOverrideEnabled()).toBe(false);
		const result = runWithRequestContext(() => flagEnabledOr("some-flag", () => true), {
			fuzzOverride: { "some-flag": true },
		});
		expect(result).toBe(false); // PostHog's real value, not the override
		vi.unstubAllEnvs();
	});

	it("is inert outside production when the opt-in env var is unset", async () => {
		vi.stubEnv("DEPLOY_ENV", "development");
		const { flagEnabledOr } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		const result = runWithRequestContext(() => flagEnabledOr("some-flag", () => false), {
			fuzzOverride: { "some-flag": true },
		});
		expect(result).toBe(false); // fallback, override never consulted
		vi.unstubAllEnvs();
	});

	it("wins over both PostHog and the fallback once enabled outside production", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "development");
		getAllFlags.mockResolvedValue({ "some-flag": false });
		const { refreshFlags, flagEnabledOr } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		await refreshFlags();
		const result = runWithRequestContext(() => flagEnabledOr("some-flag", () => false), {
			fuzzOverride: { "some-flag": true },
		});
		expect(result).toBe(true);
		vi.unstubAllEnvs();
	});

	// agentModeEnabled() reads AGENT_MODE_FLAG through flagEnabledOr, which has the override;
	// agentModeEnabledForUser() reads AGENT_MODE_ACCESS_FLAG through flagEnabledForUser, which must have
	// it too, or an override request clears the first agent-mode gate and is refused at the second
	// (CUR-1664). Asserting on getFeatureFlag rather than only on the
	// return value: the contract is that the override SHORT-CIRCUITS, so a version that happened to
	// return true because PostHog also said true would not satisfy this.
	it("reaches the per-user path, so the second agent-mode gate can be exercised too", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "preview");
		getFeatureFlag.mockResolvedValue(false); // PostHog says no; the override must still win
		const { flagEnabledForUser } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		const result = await runWithRequestContext(
			() => flagEnabledForUser("agent-mode-access", ACCOUNT_ID, {}),
			{ fuzzOverride: { "agent-mode-access": true } }
		);
		expect(
			result,
			"the fuzz override never reached the per-user path — a harness can clear the deployment-wide agent-mode gate and is still refused per-account"
		).toBe(true);
		expect(
			getFeatureFlag,
			"the override did not short-circuit: PostHog was consulted anyway, so this passes only when PostHog happens to agree"
		).not.toHaveBeenCalled();
		vi.unstubAllEnvs();
	});

	it("is inert on the per-user path in production, however the context is set", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "production");
		getFeatureFlag.mockResolvedValue(false);
		const { flagEnabledForUser } = await import("./flags");
		const { runWithRequestContext } = await import("./requestContext");
		const result = await runWithRequestContext(
			() => flagEnabledForUser("agent-mode-access", ACCOUNT_ID, {}),
			{ fuzzOverride: { "agent-mode-access": true } }
		);
		expect(
			result,
			"a fuzz override took effect IN PRODUCTION — the one invariant this mechanism has"
		).toBe(false);
		expect(getFeatureFlag).toHaveBeenCalled();
		vi.unstubAllEnvs();
	});
});

// Preview has FUZZ_OVERRIDE_ENABLED on for the scenario suite, so the deployment-level gate alone
// would let any anonymous visitor force a flag. A hosted request has to carry the key (CUR-3516).
describe("fuzz override key (CUR-3516) — a hosted preview honours the cookie only from the harness", () => {
	async function authorized(env: string | undefined, key: string | undefined) {
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		cfg.E2E_OTP_BYPASS_TOKEN = "harness-secret";
		vi.stubEnv("DEPLOY_ENV", env ?? "");
		vi.stubEnv("VERCEL_ENV", "");
		const { fuzzOverrideAuthorized } = await import("./flags");
		const result = await fuzzOverrideAuthorized(key);
		vi.unstubAllEnvs();
		return result;
	}

	it("refuses a preview request with no key, or the wrong one", async () => {
		expect(await authorized("preview", undefined)).toBe(false);
		expect(await authorized("preview", "")).toBe(false);
		expect(await authorized("preview", "harness-secreT")).toBe(false);
	});

	it("accepts a preview request carrying the harness token", async () => {
		expect(await authorized("preview", "harness-secret")).toBe(true);
	});

	it("refuses every preview request when no token is configured, even one whose key is empty", async () => {
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "preview");
		const { fuzzOverrideAuthorized } = await import("./flags");
		expect(await fuzzOverrideAuthorized("")).toBe(false);
		expect(await fuzzOverrideAuthorized("anything")).toBe(false);
		vi.unstubAllEnvs();
	});

	it("refuses production even with the right key", async () => {
		expect(await authorized("production", "harness-secret")).toBe(false);
	});

	it("needs no key on a local server, where the Dev flags dialog sets the cookie", async () => {
		expect(await authorized("development", undefined)).toBe(true);
	});

	it("refuses a deployment that declares no environment, key or not (CUR-1881)", async () => {
		expect(await authorized(undefined, undefined)).toBe(false);
		expect(await authorized(undefined, "harness-secret")).toBe(false);
	});
});

describe("per-account rollout values (CUR-2463)", () => {
	const ACCOUNT = "0123456789abcdef01234567";

	it("evaluates with the account id as distinct id and env, account id, signed_in and email as properties", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { accountFlagValues } = await import("./flags");
		await accountFlagValues(ACCOUNT, "someone@example.org");
		expect(getAllFlags).toHaveBeenCalledTimes(1);
		const [distinctId, options] = getAllFlags.mock.calls[0];
		expect(distinctId).toBe(ACCOUNT);
		expect(options.personProperties).toEqual({
			env: "preview",
			instance: "www",
			account_id: ACCOUNT,
			signed_in: "true",
			email: "someone@example.org",
		});
	});

	it("an account on an event instance is evaluated with that instance's name", async () => {
		configured();
		vi.stubEnv("INSTANCE", "lugano");
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { accountFlagValues } = await import("./flags");
		await accountFlagValues(ACCOUNT, undefined);
		const [, options] = getAllFlags.mock.calls[0];
		expect(options.personProperties.instance).toBe("lugano");
		vi.unstubAllEnvs();
	});

	// The sign-in hint for a guest is asked of PostHog for the guest, not a stand-in account. (CUR-3015)
	it("a guest's sign-in answer is evaluated for its own hashed id, signed in, with an empty email and account id", async () => {
		configured();
		getAllFlags.mockResolvedValue({ multimodal: true });
		const { guestSignInFlagValues } = await import("./flags");
		const values = await guestSignInFlagValues("session-a", 1500);
		expect(values?.get("multimodal")).toBe(true);
		const [distinctId, options] = getAllFlags.mock.calls[0];
		expect(distinctId).toMatch(/^guest-[0-9a-f]{32}$/);
		expect(distinctId).not.toContain("session-a");
		expect(options.personProperties).toEqual({ env: "preview", instance: "www", signed_in: "true", account_id: "", email: "" });
	});

	it("two guests are two distinct ids, so a percentage rollout buckets each one", async () => {
		configured();
		getAllFlags.mockResolvedValue({ multimodal: true });
		const { guestSignInFlagValues } = await import("./flags");
		await guestSignInFlagValues("session-a", 1500);
		await guestSignInFlagValues("session-b", 1500);
		expect(getAllFlags).toHaveBeenCalledTimes(2);
		const [first, second] = getAllFlags.mock.calls.map((c) => c[0]);
		expect(first).not.toBe(second);
	});

	it("a guest's answer never stands in for an account's", async () => {
		configured();
		getAllFlags.mockResolvedValueOnce({ multimodal: true }); // the guest
		getAllFlags.mockResolvedValueOnce({ multimodal: false }); // the account
		const { guestSignInFlagValues, accountFlagValues } = await import("./flags");
		await guestSignInFlagValues(ACCOUNT, 1500);
		expect((await accountFlagValues(ACCOUNT, undefined))?.get("multimodal")).toBe(false);
	});

	it("an account-scoped flag reads the account's answer over the deployment snapshot", async () => {
		configured();
		getAllFlags.mockResolvedValueOnce({ dictation: false }); // the deployment snapshot
		getAllFlags.mockResolvedValueOnce({ dictation: true }); // this account
		const { refreshFlags, accountFlagValues, flagEnabledOr } = await import("./flags");
		const { runWithRequestContext, updateRequestContext } = await import("./requestContext");
		await refreshFlags();
		const accountFlags = await accountFlagValues(ACCOUNT, "a@example.org");
		const signedIn = runWithRequestContext(() => {
			updateRequestContext({ accountFlags });
			return flagEnabledOr("dictation", () => false);
		});
		const signedOut = runWithRequestContext(() => flagEnabledOr("dictation", () => false));
		expect(signedIn).toBe(true);
		expect(signedOut).toBe(false);
	});

	it("a deployment-scoped flag ignores the account's answer (the model registry is shared)", async () => {
		configured();
		getAllFlags.mockResolvedValueOnce({ "model-picker": false });
		getAllFlags.mockResolvedValueOnce({ "model-picker": true });
		const { refreshFlags, accountFlagValues, flagEnabledOr } = await import("./flags");
		const { runWithRequestContext, updateRequestContext } = await import("./requestContext");
		await refreshFlags();
		const accountFlags = await accountFlagValues(ACCOUNT, "a@example.org");
		const result = runWithRequestContext(() => {
			updateRequestContext({ accountFlags });
			return flagEnabledOr("model-picker", () => false);
		});
		expect(result).toBe(false);
	});

	it("the fuzz override still wins over the account's answer", async () => {
		configured();
		cfg.FUZZ_OVERRIDE_ENABLED = "true";
		vi.stubEnv("DEPLOY_ENV", "preview");
		const { flagEnabledOr } = await import("./flags");
		const { runWithRequestContext, updateRequestContext } = await import("./requestContext");
		const result = runWithRequestContext(
			() => {
				updateRequestContext({ accountFlags: new Map([["dictation", true]]) });
				return flagEnabledOr("dictation", () => true);
			},
			{ fuzzOverride: { dictation: false } }
		);
		expect(result).toBe(false);
		vi.unstubAllEnvs();
	});

	it("answers a repeat request from the cache, and refreshes only once the entry is stale", async () => {
		configured();
		getAllFlags.mockResolvedValue({ dictation: true });
		const { accountFlagValues, FLAG_SNAPSHOT_MAX_AGE_MS } = await import("./flags");
		await accountFlagValues(ACCOUNT, undefined);
		await accountFlagValues(ACCOUNT, undefined);
		expect(getAllFlags).toHaveBeenCalledTimes(1);
		vi.useFakeTimers({ now: Date.now() + FLAG_SNAPSHOT_MAX_AGE_MS + 1 });
		try {
			const stale = await accountFlagValues(ACCOUNT, undefined);
			expect(stale?.get("dictation")).toBe(true); // served stale, not awaited
		} finally {
			vi.useRealTimers();
		}
		await vi.waitFor(() => expect(getAllFlags).toHaveBeenCalledTimes(2)); // and a refresh started
	});

	it("returns undefined (read the snapshot) when PostHog fails or answers empty", async () => {
		configured();
		const { accountFlagValues } = await import("./flags");
		getAllFlags.mockRejectedValueOnce(new Error("posthog unreachable"));
		expect(await accountFlagValues(ACCOUNT, undefined)).toBeUndefined();
		getAllFlags.mockResolvedValueOnce({});
		expect(await accountFlagValues(ACCOUNT, undefined)).toBeUndefined();
	});

});

// Preview offers images to team accounts only, so `multimodal` must read the account's own answer
// (CUR-2725). Scoped per deployment, a team account would get the guests' "off" and no photo would
// reach the model.
describe("multimodal is answered per account (CUR-2725)", () => {
	const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaa";

	it("gives a signed-in account the flag selects images, while a guest gets the deployment's off", async () => {
		configured();
		getAllFlags.mockResolvedValueOnce({ multimodal: false }); // the deployment snapshot
		getAllFlags.mockResolvedValueOnce({ multimodal: true }); // this account
		const { refreshFlags, accountFlagValues, flagEnabledOr } = await import("./flags");
		const { runWithRequestContext, updateRequestContext } = await import("./requestContext");
		await refreshFlags();
		const accountFlags = await accountFlagValues(ACCOUNT, "a@example.org");
		const signedIn = runWithRequestContext(() => {
			updateRequestContext({ accountFlags });
			return flagEnabledOr("multimodal", () => false);
		});
		const guest = runWithRequestContext(() => flagEnabledOr("multimodal", () => false));
		expect(signedIn).toBe(true);
		expect(guest).toBe(false);
	});
});

// Remote evaluation bills every getAllFlags, per instance and per account (CUR-2897), which adds up
// across PR previews' scenario runs.
describe("local evaluation (CUR-2897) — a secret key makes every read in-process", () => {
	const ACCOUNT = "0123456789abcdef01234567";
	const withSecret = () => {
		configured();
		cfg.POSTHOG_FLAGS_SECRET_KEY = "phs_test";
	};

	it("builds the client with the secret and a definitions poll no faster than the snapshot age", async () => {
		withSecret();
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags, FLAG_SNAPSHOT_MAX_AGE_MS } = await import("./flags");
		await refreshFlags();
		expect(constructed).toHaveLength(1);
		expect(constructed[0]).toMatchObject({
			secretKey: "phs_test",
			featureFlagsPollingInterval: FLAG_SNAPSHOT_MAX_AGE_MS,
		});
		expect(constructed[0]).not.toHaveProperty("flagDefinitionCacheProvider");
	});

	it("evaluates the deployment poll locally first", async () => {
		withSecret();
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(waitForLocalEvaluationReady).toHaveBeenCalled();
		expect(getAllFlags).toHaveBeenNthCalledWith(1, "aipotluck-server", {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "" },
			onlyEvaluateLocally: true,
		});
	});

	// Local evaluation is inconclusive on a property the call doesn't pass, and an inconclusive flag
	// drops out of an onlyEvaluateLocally result. The account path must pass all three every time.
	it("passes every property a condition reads on the account path, with \"\" for a missing email", async () => {
		withSecret();
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { accountFlagValues } = await import("./flags");
		await accountFlagValues(ACCOUNT, undefined);
		expect(getAllFlags).toHaveBeenNthCalledWith(1, ACCOUNT, {
			personProperties: { env: "preview", instance: "www", account_id: ACCOUNT, signed_in: "true", email: "" },
			onlyEvaluateLocally: true,
		});
	});

	it("evaluates the per-user path locally too", async () => {
		withSecret();
		getFeatureFlag.mockResolvedValue(true);
		const { flagEnabledForUser } = await import("./flags");
		await flagEnabledForUser("agent-mode", ACCOUNT, { email: "a@example.org" });
		expect(getFeatureFlag).toHaveBeenCalledWith("agent-mode", ACCOUNT, {
			personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "a@example.org" },
			onlyEvaluateLocally: true,
			sendFeatureFlagEvents: false,
		});
	});

	// A quota cutoff (the SDK clears its local flags on a 402) and definitions that never loaded both
	// arrive as an empty result. Neither may wipe the last known values.
	it("keeps the last known values when local evaluation later returns nothing", async () => {
		withSecret();
		cfg.COMPARE_PANEL_ENABLED = "false";
		getAllFlags.mockResolvedValue({ "compare-panel": true });
		const { refreshFlags, flagEnabled } = await import("./flags");
		await refreshFlags();
		getAllFlags.mockResolvedValue({});
		await refreshFlags();
		expect(flagEnabled("compare-panel", "COMPARE_PANEL_ENABLED")).toBe(true);
	});

	// posthog-node's local getAllFlags and getFeatureFlag first await the definitions fetch with no cap.
	// The stub hangs the way the SDK does while that fetch is pending: a read made before the
	// definitions arrive never settles.
	describe("definitions that have not loaded are never read, so a hung fetch cannot hold the caller", () => {
		const hungUntilLoaded = () => {
			isLocalEvaluationReady.mockReturnValue(false);
			waitForLocalEvaluationReady.mockResolvedValue(false);
			getAllFlags.mockImplementation(() => new Promise(() => {}));
			getFeatureFlag.mockImplementation(() => new Promise(() => {}));
		};

		it("the deployment poll settles, keeping the env fallback", async () => {
			withSecret();
			hungUntilLoaded();
			cfg.COMPARE_PANEL_ENABLED = "true";
			const { refreshFlags, flagEnabled } = await import("./flags");
			await refreshFlags();
			expect(getAllFlags).not.toHaveBeenCalled();
			expect(flagEnabled("compare-panel", "COMPARE_PANEL_ENABLED")).toBe(true);
		});

		// A registry built from those fallbacks waits on whenFlagsPolled to rebuild (CUR-4194), so an
		// empty poll must leave the waiter queued and the first poll with flags must run it.
		it("whenFlagsPolled runs its callback on the first poll that returns flags, not on an empty one", async () => {
			withSecret();
			hungUntilLoaded();
			const { refreshFlags, whenFlagsPolled } = await import("./flags");
			const waiter = vi.fn();
			expect(whenFlagsPolled(waiter)).toBe(true);
			await refreshFlags();
			await Promise.resolve();
			expect(waiter).not.toHaveBeenCalled();

			isLocalEvaluationReady.mockReturnValue(true);
			waitForLocalEvaluationReady.mockResolvedValue(true);
			getAllFlags.mockResolvedValue({ "compare-panel": true });
			await refreshFlags();
			await vi.waitFor(() => expect(waiter).toHaveBeenCalledTimes(1));
			expect(whenFlagsPolled(vi.fn()), "after a good poll there is nothing to wait for").toBe(false);
		});

		it("a per-user read settles as unanswered", async () => {
			withSecret();
			hungUntilLoaded();
			const { flagEnabledForUser } = await import("./flags");
			await expect(flagEnabledForUser("agent-mode", ACCOUNT, { email: "a@example.org" })).resolves.toBeUndefined();
			expect(getFeatureFlag).not.toHaveBeenCalled();
		});
	});

	it("a PR preview with baked definitions gets a cache provider that never fetches", async () => {
		withSecret();
		baked.data = { flags: [{ key: "some-flag" }], groupTypeMapping: {}, cohorts: {}, bakedAt: "2026-10-05T00:00:00Z" };
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		const provider = constructed[0].flagDefinitionCacheProvider as {
			shouldFetchFlagDefinitions(): boolean;
			getFlagDefinitions(): unknown;
		};
		expect(provider.shouldFetchFlagDefinitions()).toBe(false);
		expect(provider.getFlagDefinitions()).toBe(baked.data);
	});

	// Develop and production bake too, as a seed. The client starts loaded from the build, so a
	// cold instance never reads code fallbacks, and every load after the first fetches live. (CUR-4199)
	it("a seeded build serves its bake for the client's first load only, then fetches live on every load after", async () => {
		withSecret();
		baked.data = { flags: [{ key: "some-flag" }], groupTypeMapping: {}, cohorts: {}, mode: "seed" };
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		const provider = constructed[0].flagDefinitionCacheProvider as {
			shouldFetchFlagDefinitions(): boolean;
			getFlagDefinitions(): unknown;
		};
		expect(provider.getFlagDefinitions()).toBe(baked.data);
		expect([1, 2, 3].map(() => provider.shouldFetchFlagDefinitions())).toEqual([false, true, true]);
	});

	it("a seeded client fetches live as soon as the seed loads, and keeps the instance awake until it does", async () => {
		withSecret();
		baked.data = { flags: [{ key: "some-flag" }], groupTypeMapping: {}, cohorts: {}, mode: "seed" };
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(held).toHaveLength(1);
		await held[0];
		expect(waitForLocalEvaluationReady).toHaveBeenCalled();
		expect(reloadFeatureFlags).toHaveBeenCalledTimes(1);
		expect(infoMock).toHaveBeenCalledWith(expect.objectContaining({ mode: "local-seeded" }), "[flags] PostHog client ready");
	});

	it("a PR preview's frozen bake starts no live fetch", async () => {
		withSecret();
		baked.data = { flags: [{ key: "some-flag" }], groupTypeMapping: {}, cohorts: {}, mode: "frozen" };
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(held).toHaveLength(0);
		expect(reloadFeatureFlags).not.toHaveBeenCalled();
	});

	it("without a secret key, reads stay remote and nothing is baked in", async () => {
		configured();
		baked.data = { flags: [{ key: "some-flag" }], groupTypeMapping: {}, cohorts: {} };
		getAllFlags.mockResolvedValue({ "some-flag": true });
		const { refreshFlags } = await import("./flags");
		await refreshFlags();
		expect(constructed[0]).not.toHaveProperty("secretKey");
		expect(constructed[0]).not.toHaveProperty("flagDefinitionCacheProvider");
		expect(waitForLocalEvaluationReady).not.toHaveBeenCalled();
		expect(getAllFlags.mock.calls[0][1]).not.toHaveProperty("onlyEvaluateLocally");
	});
	// A condition local evaluation can't answer (a fourth property, a cohort) drops its flag out of the
	// local result. That must cost a scoped remote call and a log line, never a silent fallback.
	describe("a flag local evaluation can't answer is evaluated remotely, and named", () => {
		const remoteWarn = () =>
			warnMock.mock.calls.filter((c) => String(c[1] ?? "").includes("evaluated remotely"));

		it("asks PostHog remotely for only the registry keys missing locally, and uses its answer", async () => {
			withSecret();
			const { FLAG_KEY_NAMES } = await import("./flagKeys");
			const [gap, ...rest] = FLAG_KEY_NAMES;
			getAllFlags.mockImplementation(async (_id: string, o: { onlyEvaluateLocally?: boolean }) =>
				o.onlyEvaluateLocally ? Object.fromEntries(rest.map((k) => [k, false])) : { [gap]: true }
			);
			const { refreshFlags, flagEnabled } = await import("./flags");
			await refreshFlags();
			expect(getAllFlags).toHaveBeenCalledTimes(2);
			expect(getAllFlags.mock.calls[1][1]).toEqual({
				personProperties: { env: "preview", instance: "www", account_id: "", signed_in: "", email: "" },
				flagKeys: [gap],
			});
			expect(flagEnabled(gap, "UNSET_FALLBACK_ENV")).toBe(true);
			expect(remoteWarn()).toHaveLength(1);
			expect(remoteWarn()[0][0].keys).toEqual([gap]);
		});

		it("warns once per key per process, not once per refresh", async () => {
			withSecret();
			const { FLAG_KEY_NAMES } = await import("./flagKeys");
			const [gap, ...rest] = FLAG_KEY_NAMES;
			getAllFlags.mockImplementation(async (_id: string, o: { onlyEvaluateLocally?: boolean }) =>
				o.onlyEvaluateLocally ? Object.fromEntries(rest.map((k) => [k, false])) : { [gap]: true }
			);
			const { refreshFlags } = await import("./flags");
			await refreshFlags();
			await refreshFlags();
			expect(getAllFlags).toHaveBeenCalledTimes(4);
			expect(remoteWarn()).toHaveLength(1);
		});

		it("makes no remote call when local evaluation answers every registry key", async () => {
			withSecret();
			const { FLAG_KEY_NAMES } = await import("./flagKeys");
			getAllFlags.mockResolvedValue(Object.fromEntries(FLAG_KEY_NAMES.map((k) => [k, false])));
			const { refreshFlags } = await import("./flags");
			await refreshFlags();
			expect(getAllFlags).toHaveBeenCalledTimes(1);
			expect(remoteWarn()).toHaveLength(0);
		});

		it("asks about a key PostHog doesn't define once, then leaves it to the missing-key warning", async () => {
			withSecret();
			const { FLAG_KEY_NAMES } = await import("./flagKeys");
			const [, ...rest] = FLAG_KEY_NAMES;
			getAllFlags.mockImplementation(async (_id: string, o: { onlyEvaluateLocally?: boolean }) =>
				o.onlyEvaluateLocally ? Object.fromEntries(rest.map((k) => [k, false])) : {}
			);
			const { refreshFlags } = await import("./flags");
			await refreshFlags();
			await refreshFlags();
			expect(getAllFlags).toHaveBeenCalledTimes(3);
			expect(remoteWarn()).toHaveLength(0);
			expect(warnMock.mock.calls.some((c) => String(c[1]).includes("not defined in PostHog"))).toBe(true);
		});

		it("makes no remote call on an empty local result (definitions missing or quota-cut)", async () => {
			withSecret();
			getAllFlags.mockResolvedValue({});
			const { refreshFlags } = await import("./flags");
			await refreshFlags();
			expect(getAllFlags).toHaveBeenCalledTimes(1);
		});

		it("falls back remotely on the per-user path too, and names the key", async () => {
			withSecret();
			getFeatureFlag.mockResolvedValueOnce(undefined).mockResolvedValueOnce(true);
			const { flagEnabledForUser } = await import("./flags");
			expect(await flagEnabledForUser("agent-mode", ACCOUNT, {})).toBe(true);
			expect(getFeatureFlag.mock.calls[1][2]).not.toHaveProperty("onlyEvaluateLocally");
			expect(remoteWarn()[0][0].keys).toEqual(["agent-mode"]);
		});
	});
});

// team-only release conditions match `email` against the team domains, so an address the
// provider never verified must not reach PostHog, or claiming a team domain would unlock team flags. (CUR-3182)
describe("flagEmail — only a verified address reaches a flag evaluation (CUR-3182)", () => {
	const ACCOUNT = "0123456789abcdef01234567";

	it("an unverified email on a team domain sends PostHog no email, so team-only flags stay off for it", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "agent-mode-access": false });
		const { accountFlagValues } = await import("./flags");
		const { flagEmail } = await import("./flagEmail");
		await accountFlagValues(ACCOUNT, flagEmail({ email: "someone@currentai.org", emailVerified: false }));
		const [, options] = getAllFlags.mock.calls[0];
		// "" rather than absent, so local evaluation stays conclusive (CUR-2897); either way no address.
		expect(options.personProperties.email ?? "").toBe("");
	});

	it("an email with no verification bit at all (a row from outside a Better Auth session) is treated as unverified", async () => {
		const { flagEmail } = await import("./flagEmail");
		expect(flagEmail({ email: "someone@currentai.org" })).toBeUndefined();
		expect(flagEmail(undefined)).toBeUndefined();
	});

	it("a verified email is sent as the person property team-only conditions match on", async () => {
		configured();
		getAllFlags.mockResolvedValue({ "agent-mode-access": true });
		const { accountFlagValues } = await import("./flags");
		const { flagEmail } = await import("./flagEmail");
		await accountFlagValues(ACCOUNT, flagEmail({ email: "someone@currentai.org", emailVerified: true }));
		const [, options] = getAllFlags.mock.calls[0];
		expect(options.personProperties.email).toBe("someone@currentai.org");
	});
});

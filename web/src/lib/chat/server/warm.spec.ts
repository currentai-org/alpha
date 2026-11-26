import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OutcomeAgg } from "./turnBurnRate";

// warm.ts reads serving config through the `config` proxy (not process.env), and the server test setup
// mocks $env to a static snapshot — so mock `config` directly with a mutable object we can vary per test.
const cfg: Record<string, string> = {};
vi.mock("$lib/chat/server/config", () => ({ config: cfg }));

// The flags leg: pass through to the real module unless a test sets these.
const flagsOverride = vi.hoisted(() => ({
	configured: undefined as boolean | undefined,
	refresh: undefined as (() => Promise<void>) | undefined,
	state: undefined as { polledOk: boolean; lastRefreshAt: number; size: number } | undefined,
}));
vi.mock("$lib/chat/server/flags", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/chat/server/flags")>();
	return {
		...real,
		postHogConfigured: () => flagsOverride.configured ?? real.postHogConfigured(),
		refreshFlags: () => (flagsOverride.refresh ? flagsOverride.refresh() : real.refreshFlags()),
		flagsDebugState: () => flagsOverride.state ?? real.flagsDebugState(),
	};
});

// warmModel now reports its (honest) outcome to alerting.recordProbe, which reads/writes the
// alert_state row. Mock it so the warm tests stay hermetic — and so we can assert WHAT gets reported,
// which is the whole point of the model leg carrying an alert.
const recordProbeMock = vi.fn(
	async (
		_key: string,
		_healthy: boolean,
		// Mirrors alerting.ProbeOpts (not exported); `severity` is asserted below, so it must be here.
		_opts: { label: string; runbook: string; severity?: "outage" | "degraded" }
	) => {}
);
vi.mock("$lib/chat/server/alerting", () => ({
	recordProbe: recordProbeMock,
}));

// The embeddings/db legs' work, so their probe outcomes can be driven without a real endpoint or Postgres.
// embedText is mocked; `cosine` is NOT — the identity assertion's whole job is the real ranking maths,
// and a mocked cosine would test the mock. Same reasoning as embed.live.spec.ts's header.
const embedMock = vi.fn(async (): Promise<number[] | null> => [0.1]);
vi.mock("$lib/chat/server/rag/embed", async () => {
	const actual = await vi.importActual<typeof import("$lib/chat/server/rag/embed")>(
		"$lib/chat/server/rag/embed"
	);
	return { embedText: embedMock, cosine: actual.cosine };
});
const executeMock = vi.fn(async () => [{ "?column?": 1 }]);
vi.mock("$lib/chat/server/db/client", () => ({ getDb: () => ({ execute: executeMock }) }));
const countDeclinesMock = vi.fn(async () => 0);
vi.mock("$lib/chat/server/db/safetyEvents", () => ({
	countFailClosedChildDeclines: countDeclinesMock,
}));
const countTurnOutcomeWindowsMock = vi.fn(async (): Promise<OutcomeAgg[]> => []);
const pruneTurnOutcomesMock = vi.fn(async () => 0);
const recentCompleteTtftsMock = vi.fn(async (): Promise<number[]> => []);
vi.mock("$lib/chat/server/db/turnOutcomes", () => ({
	countTurnOutcomeWindows: countTurnOutcomeWindowsMock,
	pruneTurnOutcomes: pruneTurnOutcomesMock,
	recentCompleteTtfts: recentCompleteTtftsMock,
}));

// The warm cron is what keeps BOTH the flag snapshot AND the model registry built from it fresh on a
// schedule — "warmAll actually calls it" is a real contract, not an implementation
// detail. `ensureModelsReady` builds the registry once per process at first request (a cold-start
// patch: a fresh instance would otherwise read an empty snapshot and cache "no agent model" for its
// whole life) — but never rebuilds it again on its own, so without this cron leg a flag flip never
// reaches a registry-derived surface (router-alias/agent-mode) for the rest of that
// process's life, which in practice can span more than one deploy.
const refreshRegistryGatesIfChangedMock = vi.fn(
	async (): Promise<{ changed: boolean; gates: { routerAlias: boolean; agent: boolean; sideCallLane: boolean } }> => ({
		changed: false,
		gates: { routerAlias: false, agent: false, sideCallLane: false },
	})
);
vi.mock("$lib/chat/server/models", () => ({
	refreshRegistryGatesIfChanged: refreshRegistryGatesIfChangedMock,
	// No picker models, so the probe leg (modelProbe.spec.ts covers it) calls nothing here.
	models: [],
	isSelectableModel: () => true,
}));

// The error-rate leg reads (and RESETS) an in-process counter owned by errorTracking. Mocked so a test
// can set the count directly — the counter's own reset semantics are covered in errorTracking.spec.ts.
const takeErrorCountMock = vi.fn(() => 0);
const captureServerExceptionMock = vi.fn(async () => {});
vi.mock("$lib/chat/server/errorTracking", () => ({
	takeErrorCount: takeErrorCountMock,
	captureServerException: captureServerExceptionMock,
}));

// Same shape as the error-rate leg above — an in-process counter owned by
// resolveAgentRoute.ts, mocked so a test can set the count directly. The counter's own
// increment/reset/reason-classification behavior is covered in resolveAgentRoute.spec.ts.
const takeAgentRouteFailureCountMock = vi.fn(() => 0);
vi.mock("$lib/chat/server/chat/resolveAgentRoute", () => ({
	takeAgentRouteFailureCount: takeAgentRouteFailureCountMock,
}));
const warmModerationMock = vi.fn(async () => {});
// The review-plane config leg: which Coop keys are unset, and whether this process is a deployment.
const coopReviewConfigMissingMock = vi.fn((): string[] => []);
const isDeploymentMock = vi.fn(() => false);
// ALPHA_EDITION=selfhost: a self-host with no Shieldstral endpoint has no guard leg to probe.
const isSelfHostEditionMock = vi.fn(() => false);
vi.mock("$lib/chat/server/moderation", () => ({
	warmModeration: warmModerationMock,
	coopReviewConfigMissing: coopReviewConfigMissingMock,
	isDeployment: isDeploymentMock,
	isSelfHostEdition: isSelfHostEditionMock,
}));

// The agent screen endpoint's bearer: armed (set) keeps a self-host's guard leg loud with no classifier.
const safetyScreenTokenMock = vi.fn((): string | undefined => undefined);
vi.mock("$lib/chat/server/safetyScreen", () => ({ safetyScreenToken: safetyScreenTokenMock }));

// guardGate: only the symbols warm.ts reads. guardPrimaryConfigured is GUARD_SHADOW_URL's presence; unset
// by default, so the guard leg records unhealthy unless a test configures it.
const guardPrimaryConfiguredMock = vi.fn(() => false);
const probeGuardHealthMock = vi.fn(async () => null as unknown);
// The S1 leg: s1JudgeFor is the s1-safety-judge flag read (undefined = off, the default) and
// probeS1Health is the probe, null when the S1 key or endpoint is unset.
const s1JudgeForMock = vi.fn((): unknown => undefined);
const probeS1HealthMock = vi.fn(async (_s1: unknown): Promise<unknown> => null);
vi.mock("$lib/chat/server/guardGate", () => ({
	guardPrimaryConfigured: guardPrimaryConfiguredMock,
	probeGuardHealth: probeGuardHealthMock,
	s1JudgeFor: s1JudgeForMock,
	probeS1Health: probeS1HealthMock,
}));

// warmSyftCatalog dynamically imports this module (so the SDK never loads when the router is off);
// mocked so the catalog leg's failure-open behavior can be driven without a real SyftHub client.
const getSyftCatalogMock = vi.fn(async (): Promise<{ sources: unknown[] } | null> => ({ sources: [] }));
vi.mock("$lib/chat/server/rag/syftCatalog", () => ({ getSyftCatalog: getSyftCatalogMock }));

const fetchMock = vi.fn();

// The identity legs' own log line (not just recordProbe) is what the fix is about — a probe
// that only logs its failure case reads as silence on Axiom for both "matched every time" and "never
// ran," which is indistinguishable from the outside. Mocked so tests below can assert the leg logs on
// EVERY outcome — match, mismatch, and identity-unknown — not just the mismatch case.
const loggerWarnMock = vi.fn();
const loggerInfoMock = vi.fn();
const loggerErrorMock = vi.fn();
vi.mock("$lib/chat/server/logger", () => ({
	logger: {
		warn: (...args: unknown[]) => loggerWarnMock(...args),
		info: (...args: unknown[]) => loggerInfoMock(...args),
		error: (...args: unknown[]) => loggerErrorMock(...args),
	},
}));

// Every "two calls → one probe" assertion below is a statement about warm.ts's throttle, and that throttle
// compares against a real Date.now(). The production windows are short (15s for db, 30s for most), so
// without a fixed window those assertions hold only if both calls land inside it in WALL-CLOCK time, which
// fails under host load.
//
// WARM_THROTTLE_MS replaces every leg's window (warm.ts, the throttleMs helper). An hour is far
// past anything a loaded box can burn between two awaited calls, so the throttle assertions now
// state what they mean — "the second call short-circuits" — rather than "the second call
// short-circuits provided this machine was not busy".
//
// Tests that need the window to LAPSE still use vi.resetModules(), which re-imports warm.ts with
// its lastWarmAt back at 0. That is a fresh module rather than an elapsed window; it was already
// load-independent, so it is left alone.
const WARM_THROTTLE_MS_FOR_TESTS = String(60 * 60_000);

beforeEach(() => {
	vi.resetModules(); // reset warm.ts's module-level throttle timestamp between tests
	for (const k of Object.keys(cfg)) delete cfg[k];
	Object.assign(cfg, {
		OPENAI_BASE_URL: "https://router.test/v1",
		OPENAI_API_KEY: "hf_warmtest",
		MODEL_ALLOWLIST: "swiss-ai/Apertus-70B-Instruct-2509",
		OPENAI_PROVIDER: "publicai",
		WARM_THROTTLE_MS: WARM_THROTTLE_MS_FOR_TESTS,
	});
	fetchMock.mockReset();
	recordProbeMock.mockClear();
	takeErrorCountMock.mockClear();
	takeErrorCountMock.mockReturnValue(0);
	captureServerExceptionMock.mockClear();
	takeAgentRouteFailureCountMock.mockClear();
	takeAgentRouteFailureCountMock.mockReturnValue(0);
	embedMock.mockClear();
	embedMock.mockResolvedValue([0.1]);
	executeMock.mockClear();
	executeMock.mockResolvedValue([{ "?column?": 1 }]);
	countDeclinesMock.mockClear();
	countDeclinesMock.mockResolvedValue(0);
	countTurnOutcomeWindowsMock.mockReset();
	countTurnOutcomeWindowsMock.mockResolvedValue([]);
	pruneTurnOutcomesMock.mockClear();
	pruneTurnOutcomesMock.mockResolvedValue(0);
	recentCompleteTtftsMock.mockReset();
	recentCompleteTtftsMock.mockResolvedValue([]);
	refreshRegistryGatesIfChangedMock.mockClear();
	refreshRegistryGatesIfChangedMock.mockResolvedValue({
		changed: false,
		gates: { routerAlias: false, agent: false, sideCallLane: false },
	});
	warmModerationMock.mockClear();
	isSelfHostEditionMock.mockReset();
	isSelfHostEditionMock.mockReturnValue(false);
	safetyScreenTokenMock.mockReset();
	safetyScreenTokenMock.mockReturnValue(undefined);
	coopReviewConfigMissingMock.mockReset();
	coopReviewConfigMissingMock.mockReturnValue([]);
	isDeploymentMock.mockReset();
	isDeploymentMock.mockReturnValue(false);
	guardPrimaryConfiguredMock.mockReset();
	guardPrimaryConfiguredMock.mockReturnValue(false);
	probeGuardHealthMock.mockReset();
	probeGuardHealthMock.mockResolvedValue(null);
	s1JudgeForMock.mockReset();
	s1JudgeForMock.mockReturnValue(undefined);
	probeS1HealthMock.mockReset();
	probeS1HealthMock.mockResolvedValue(null);
	getSyftCatalogMock.mockClear();
	getSyftCatalogMock.mockResolvedValue({ sources: [] });
	loggerWarnMock.mockClear();
	loggerInfoMock.mockClear();
	loggerErrorMock.mockClear();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("warmModel — shared-model prewarm", () => {
	it("fires a 1-token completion on the PROVIDER-PINNED model id (same lane the real turn uses)", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.test/v1/chat/completions");
		const body = JSON.parse(init.body as string);
		expect(body.model).toBe("swiss-ai/Apertus-70B-Instruct-2509:publicai"); // pinned, not bare
		expect(body.max_tokens).toBe(1);
		expect(body.stream).toBe(false);
	});

	// Apertus 1.5 refused any system role on some hosts, so its answers go out flattened to one
	// user message. The probe sends the answer lane's shape, never an easier one.
	it("sends a flattened model one user message, the shape its answers go out in", async () => {
		cfg.MODEL_ALLOWLIST = "swiss-ai/apertus-v1.5-70b";
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string);
		expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user"]);
	});

	// develop's default is Mistral Large 3 on Mistral's own API, which the gateway does not serve. A
	// direct lane has no cold start and no substitution to catch, so the leg is skipped, visibly, instead of
	// spending the provider's rate limit on every page load.
	it("skips the model leg, with a log line, when the primary is served by a direct lane", async () => {
		Object.assign(cfg, {
			MODEL_ALLOWLIST: "mistral-large-2512,swiss-ai/Apertus-70B-Instruct-2509",
			MISTRAL_BASE_URL: "https://api.mistral.test/v1",
			MISTRAL_API_KEY: "mistral-warmtest",
			MISTRAL_MODELS: "mistral-large-2512",
		});
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(loggerInfoMock).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "model", model: "mistral-large-2512", skipped: "direct-lane" }),
			"[warm] leg skipped"
		);
	});

	// The skip above must not fire when the primary is served through the router, or the one alerting probe
	// on the default model stops. The router is a caching LiteLLM gateway, so it is probed, on
	// its own host and key, under its own name for the model (`mistralai/mistral-large-2512`), with no
	// MISTRAL_API_KEY set.
	const onRouter = () =>
		Object.assign(cfg, {
			MODEL_ALLOWLIST: "mistral-large-2512,swiss-ai/Apertus-70B-Instruct-2509",
			MISTRAL_CHAT_BASE_URL: "https://router.mistral.test/v1/",
			MISTRAL_CHAT_API_KEY: "router-warmtest",
			MISTRAL_CHAT_MODEL_MAP: "mistral-large-2512=mistralai/mistral-large-2512",
			MISTRAL_MODELS: "mistral-large-2512",
		});

	it("probes a Mistral primary on the router lane it is served from, never skipped and never on OPENAI_BASE_URL", async () => {
		onRouter();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "mistralai/mistral-large-2512" }), {
				status: 200,
				headers: { "x-litellm-model-api-base": "https://api.mistral.ai/v1" },
			})
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.mistral.test/v1/chat/completions");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer router-warmtest");
		expect(JSON.parse(init.body as string).model).toBe("mistralai/mistral-large-2512");
		// Large 3 answers carry a system role, so the probe does too and a host that refuses it fails here.
		expect(JSON.parse(init.body as string).messages.map((m: { role: string }) => m.role)).toEqual([
			"system",
			"user",
		]);
		expect(loggerInfoMock).not.toHaveBeenCalledWith(
			expect.objectContaining({ skipped: "direct-lane" }),
			expect.anything()
		);
		expect(recordProbeMock).toHaveBeenCalledWith("model:warm", true, expect.anything());
		expect(recordProbeMock).toHaveBeenCalledWith("model:identity", true, expect.anything());
	});

	it("alerts model:warm when the router lane fails, with a runbook that names the router, not OPENAI_BASE_URL", async () => {
		onRouter();
		fetchMock.mockResolvedValue(new Response("upstream down", { status: 503 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		const call = recordProbeMock.mock.calls.find(([key]) => key === "model:warm");
		expect(call?.[1]).toBe(false);
		expect(call?.[2].runbook).toContain("MISTRAL_CHAT_BASE_URL");
	});

	// The router's 30/min Large limit is shared with visitors' turns, so a busy minute answers the probe
	// 429. That must not count toward the 3-in-a-row down alert, and must not clear it either.
	it("records no model:warm verdict on a 429 (busy), and logs the leg as busy", async () => {
		onRouter();
		fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock).not.toHaveBeenCalled();
		expect(loggerWarnMock).toHaveBeenCalledWith(
			expect.objectContaining({ leg: "model", ok: false, busy: true, err: "HTTP 429" }),
			"[warm] leg"
		);
	});

	it("goes red on model:identity when the router answers with a model other than the one asked for", async () => {
		onRouter();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "mistralai/mistral-medium-3-5" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock).toHaveBeenCalledWith("model:identity", false, expect.anything());
	});

	// The router serves Medium 3.5 from Scaleway too, which reports its own name for the same weights.
	it("stays green on model:identity when the router answers with a SERVED_AS name for the model asked for", async () => {
		Object.assign(cfg, {
			MODEL_ALLOWLIST: "mistral-medium-2604",
			MISTRAL_CHAT_BASE_URL: "https://router.mistral.test/v1/",
			MISTRAL_CHAT_API_KEY: "router-warmtest",
			MISTRAL_CHAT_MODEL_MAP: "mistral-medium-2604=mistralai/mistral-medium-2604",
			MISTRAL_MODELS: "mistral-medium-2604",
		});
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: "mistral-medium-3.5-128b" }), { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock).toHaveBeenCalledWith("model:identity", true, expect.anything());
	});

	// A per-ticket preview billing MISTRAL_API_KEY_CI stays on La Plateforme even with the router set
	// (mistralKey.ts), so it keeps the skip.
	it("still skips on a ticket-branch preview, where the Mistral lane is La Plateforme on the CI key", async () => {
		onRouter();
		Object.assign(cfg, {
			MISTRAL_BASE_URL: "https://api.mistral.test/v1",
			MISTRAL_API_KEY_CI: "mistral-ci-warmtest",
		});
		vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/some-ticket");
		try {
			fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
			const { warmModel } = await import("./warm");
			await warmModel();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(loggerInfoMock).toHaveBeenCalledWith(
				expect.objectContaining({ leg: "model", model: "mistral-large-2512", skipped: "direct-lane" }),
				"[warm] leg skipped"
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps probing the gateway when the primary is not one of the direct models", async () => {
		Object.assign(cfg, {
			MISTRAL_BASE_URL: "https://api.mistral.test/v1",
			MISTRAL_API_KEY: "mistral-warmtest",
			MISTRAL_MODELS: "mistral-large-2512",
		});
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://router.test/v1/chat/completions");
	});

	// With a fixed prompt the gateway's response cache answers the probe without reaching a model, so it
	// reads ok while real turns time out. Two probes must never send the same request.
	it("sends a prompt no response cache can answer — two probes never send the same messages", async () => {
		vi.useFakeTimers();
		try {
			fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
			const { warmModel } = await import("./warm");
			await warmModel();
			vi.advanceTimersByTime(24 * 60 * 60_000); // past any throttle
			await warmModel();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const [first, second] = fetchMock.mock.calls.map(
				([, init]) => JSON.parse((init as RequestInit).body as string).messages
			);
			expect(first).not.toEqual(second);
		} finally {
			vi.useRealTimers();
		}
	});

	// A cache hit still reports a backend, so the backend field could not show the old fixed
	// prompt was never reaching a model. The line has to say which one it was.
	it("logs a gateway cache hit as cached, and a model answer as not cached", async () => {
		const modelLine = () =>
			[...loggerInfoMock.mock.calls, ...loggerWarnMock.mock.calls].find(
				([f]) => (f as { leg?: string }).leg === "model"
			)?.[0] as { cached?: boolean } | undefined;
		vi.useFakeTimers();
		try {
			const { warmModel } = await import("./warm");
			fetchMock.mockResolvedValueOnce(
				new Response("{}", { status: 200, headers: { "x-litellm-cache-key": "litellm.caching:abc" } })
			);
			await warmModel();
			expect(modelLine()?.cached).toBe(true);
			loggerInfoMock.mockClear();
			loggerWarnMock.mockClear();
			vi.advanceTimersByTime(24 * 60 * 60_000);
			fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
			await warmModel();
			expect(modelLine()?.cached).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("throttles repeat warms within the window (two calls → one fetch)", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		await warmModel();
		expect(fetchMock).toHaveBeenCalledTimes(1); // second call short-circuits on the throttle
	});

	it("skips silently when serving config is incomplete (no fetch)", async () => {
		cfg.OPENAI_BASE_URL = "";
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is best-effort: a cold/erroring backend never throws", async () => {
		fetchMock.mockRejectedValue(new Error("cold start"));
		const { warmModel } = await import("./warm");
		await expect(warmModel()).resolves.toBeUndefined();
	});

	it("reports HEALTHY to alerting on a 2xx", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
		const [key, healthy] = recordProbeMock.mock.calls[0]!;
		expect(key).toBe("model:warm");
		expect(healthy).toBe(true);
	});

	// The regression this guards: fetch RESOLVES on 4xx/5xx, so without the explicit status check a WAF
	// 403 / provider 503 / rotated-out model id logs ok=true and can never alert. A leg that cannot
	// go red is not monitoring.
	it.each([403, 500, 503])("reports UNHEALTHY on a non-2xx (%i), which fetch does not throw on", async (status) => {
		fetchMock.mockResolvedValue(new Response("nope", { status }));
		const { warmModel } = await import("./warm");
		await expect(warmModel()).resolves.toBeUndefined(); // still best-effort
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
		const [key, healthy] = recordProbeMock.mock.calls[0]!;
		expect(key).toBe("model:warm");
		expect(healthy).toBe(false);
	});

	it("reports UNHEALTHY when the endpoint is unreachable", async () => {
		fetchMock.mockRejectedValue(new Error("cold start"));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
	});

	// ── Served-model identity ───────────────────────────────────────────────────────────
	// The gap these close: a backup lane can serve a different checkpoint (zai-org/GLM-5.2) while model:warm
	// reports ok=true on every probe. Reachability is not the question. Note every case below asserts on the
	// model:identity probe SPECIFICALLY — folding this into model:warm would make a healthy endpoint serving
	// the wrong checkpoint look unreachable.
	const identityCall = () => recordProbeMock.mock.calls.find(([k]) => k === "model:identity");

	it("reports UNHEALTHY identity when a DIFFERENT model answers on a healthy endpoint", async () => {
		// Exactly the prod shape: 200 OK, endpoint fine, someone else's checkpoint on the wire.
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "zai-org/GLM-5.2" }), {
				status: 200,
				headers: { "x-inference-provider": "together" },
			})
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		// The reachability probe stays GREEN — the endpoint really is healthy. That separation is the point.
		expect(recordProbeMock.mock.calls.find(([k]) => k === "model:warm")?.[1]).toBe(true);
		expect(identityCall()?.[1]).toBe(false);
	});

	it("reports HEALTHY identity when the configured model answers", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "swiss-ai/Apertus-70B-Instruct-2509" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()?.[1]).toBe(true);
	});

	it("prefers the router's X-Router-Model header over the body, as the turn path does", async () => {
		// Header and body disagree; the header is the router's own report of what served.
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "swiss-ai/Apertus-70B-Instruct-2509" }), {
				status: 200,
				headers: { "X-Router-Model": "zai-org/GLM-5.2" },
			})
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()?.[1]).toBe(false);
	});

	it("matches despite the provider pin and casing — our request id carries `:publicai`, the reply never echoes it", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "SWISS-AI/apertus-70b-instruct-2509" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()?.[1]).toBe(true); // not a false alarm every single minute
	});

	// Absent evidence must not read as a mismatch. A host that reports no provenance leaves identity
	// UNKNOWN, and claiming "mismatch" there would page on silence — the fail-open trap inverted.
	it("makes NO identity claim when the host reports no served model", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()).toBeUndefined();
	});

	it("makes NO identity claim when the endpoint is down — that is an outage, not a substitution", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()).toBeUndefined();
	});

	// The leg logs the match case as well as the mismatch, so an Axiom search for `leg:
	// "model-identity"` returning zero rows cannot be read as either "every cycle matched" or "the branch
	// never ran". Every case below asserts a real log line landed, not just the recordProbe verdict already
	// covered above.
	const identityLog = () =>
		[...loggerInfoMock.mock.calls, ...loggerWarnMock.mock.calls].find(
			([fields]) => (fields as { leg?: string }).leg === "model-identity"
		);

	it("logs a MATCH, not just a mismatch — the gap that made a clean multi-day run look like silence", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "swiss-ai/Apertus-70B-Instruct-2509" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(loggerInfoMock).toHaveBeenCalled();
		const [fields] = identityLog()!;
		expect((fields as { ok: boolean }).ok).toBe(true);
	});

	it("logs a MISMATCH with the expected/actual pair", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ model: "zai-org/GLM-5.2" }), { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		const [fields] = identityLog()!;
		expect(fields).toMatchObject({
			ok: false,
			expected: "swiss-ai/apertus-70b-instruct-2509",
			actual: "zai-org/glm-5.2",
		});
	});

	it("logs the case with no recordProbe verdict at all — no served model, endpoint otherwise healthy", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(identityCall()).toBeUndefined(); // still no alerting verdict — recordProbe's own contract
		const [fields] = identityLog()!; // but NOT silent — this is the fix
		expect((fields as { ok: unknown }).ok).toBeNull();
	});

	it("does NOT log a model-identity line at all when the endpoint itself is down", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		// Unreachability is model:warm's own leg line (already asserted elsewhere) — the identity leg staying
		// silent here is correct: there is nothing to say about identity when nothing answered at all.
		expect(identityLog()).toBeUndefined();
	});

	// ── The probe follows what a real default turn gets, not a constant ───────────────────────────
	// Stated as a contract: if a default turn resolves to a second registration while this leg probes the
	// configured primary, `model:identity` reports green about a lane no user is on (the failure one
	// lane over). The registrations are collapsed, so the primary is the served lane and these
	// read as ordinary. They are not: the assertion below reads the id that went out on the wire, and
	// anything that reintroduces a substitution has to move this probe in the same change or it goes
	// quietly back to asserting the wrong thing.
	const sentTo = () => {
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		return { url: String(url), model: JSON.parse(String((init as RequestInit)?.body)).model as string };
	};

	it("probes the configured primary — the lane a default turn resolves to", async () => {
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "swiss-ai/Apertus-70B-Instruct-2509" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(sentTo()).toEqual({
			url: "https://router.test/v1/chat/completions",
			model: "swiss-ai/Apertus-70B-Instruct-2509:publicai",
		});
		expect(identityCall()?.[1]).toBe(true);
	});

	it("calls the lane UNHEALTHY when a DIFFERENT checkpoint answers on it", async () => {
		// The failure this leg is named for, injured the way it actually breaks: the endpoint is healthy
		// and a checkpoint we did not ask for is answering. Reachability stays green; identity goes red.
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ model: "swiss-ai/apertus-v1.5-70b" }), { status: 200 })
		);
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock.mock.calls.find(([k]) => k === "model:warm")?.[1]).toBe(true);
		expect(identityCall()?.[1]).toBe(false);
	});

	it("reports NOTHING when the leg is skipped (incomplete config is not an outage)", async () => {
		cfg.OPENAI_BASE_URL = "";
		const { warmModel } = await import("./warm");
		await warmModel();
		expect(recordProbeMock).not.toHaveBeenCalled();
	});

	it("reports NOTHING on a throttle skip (a skipped probe must not reset the failure count)", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmModel } = await import("./warm");
		await warmModel();
		await warmModel(); // inside the throttle window
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
	});
});

describe("warmEmbeddings / warmDb — honest legs report to alerting", () => {
	it("embeddings: healthy on success, DEGRADED severity on failure (consumers fail open)", async () => {
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(recordProbeMock.mock.calls[0]?.[0]).toBe("embeddings:warm");
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);

		vi.resetModules(); // clear the throttle so the second warm actually runs
		recordProbeMock.mockClear();
		embedMock.mockRejectedValue(new Error("endpoint asleep"));
		const again = await import("./warm");
		await expect(again.warmEmbeddings()).resolves.toBeUndefined(); // still best-effort
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
		expect(recordProbeMock.mock.calls[0]?.[2].severity).toBe("degraded");
	});

	// ── Embedding-space identity ────────────────────────────────────────────────
	// Same gap the model leg has, one layer over, and invisible to check:rag-index by construction:
	// that gate compares idx.model to RAG_EMBEDDING_MODEL, while production resolves through
	// RAG_EMBEDDING_ENDPOINT_URL whose served model is set in the HF console. Against the production index,
	// the index's own model scores 1.000000, BAAI/bge-small-en-v1.5 scores 0.216, and paraphrase-MiniLM-L6-v2
	// scores 0.489, all dim 384, all passing every shape assertion, and the last one sits ABOVE
	// RAG_MIN_SCORE (0.35). A quietly wrong model stays hidden longer than a down one.
	const identityCall = () => recordProbeMock.mock.calls.find(([k]) => k === "embeddings:identity");
	const probeChunk = async () => {
		const idx = (await import("$lib/chat/server/rag/data/rag-index.json")).default;
		return idx.chunks.find((c) => c.id === "policy.delete-data") ?? idx.chunks[0];
	};

	it("reports HEALTHY identity when the endpoint returns the index's own vector", async () => {
		const chunk = await probeChunk();
		embedMock.mockResolvedValue(chunk.vector); // cosine 1.0 against itself
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(identityCall()?.[1]).toBe(true);
	});

	// Same as model-identity: a match logs a line, so this leg's own Axiom silence cannot be read as
	// either "matching every cycle" or "not running."
	it("logs a MATCH, not just a mismatch", async () => {
		const chunk = await probeChunk();
		embedMock.mockResolvedValue(chunk.vector);
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		const [fields] = loggerInfoMock.mock.calls.find(
			([f]) => (f as { leg?: string }).leg === "embeddings-identity"
		)!;
		expect((fields as { ok: boolean }).ok).toBe(true);
	});

	// THE case that motivates a cosine floor instead of a shape check: right dimension, wrong space.
	it("reports UNHEALTHY identity for a same-dimension model in a DIFFERENT vector space", async () => {
		const chunk = await probeChunk();
		// Reverse the vector: identical length, near-zero similarity, passes every shape assertion.
		embedMock.mockResolvedValue([...chunk.vector].reverse());
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(recordProbeMock.mock.calls.find(([k]) => k === "embeddings:warm")?.[1]).toBe(true);
		expect(identityCall()?.[1]).toBe(false); // healthy endpoint, wrong geometry
	});

	// cosine() returns 0 on a length mismatch by design (embed.ts:139), so a dim change would otherwise
	// look like "scored badly" rather than "is a different model". Either way it must not pass.
	it("reports UNHEALTHY identity on a dimension change", async () => {
		embedMock.mockResolvedValue(new Array(768).fill(0.1));
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(identityCall()?.[1]).toBe(false);
	});

	it("makes NO identity claim when the endpoint is down — that is degradation, not a swap", async () => {
		embedMock.mockRejectedValue(new Error("endpoint asleep"));
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(identityCall()).toBeUndefined();
	});

	it("makes NO identity claim when embedText returns null (fail-open, no vector to compare)", async () => {
		embedMock.mockResolvedValue(null);
		const { warmEmbeddings } = await import("./warm");
		await warmEmbeddings();
		expect(identityCall()).toBeUndefined();
	});

	// THE HOLE THIS CLOSES: embedText fails OPEN internally — a non-OK response, an
	// unexpected shape, or a network error all resolve to `null` rather than throwing. Under the old
	// timedWarm, "did the call throw" was the whole verdict, so every one of those failures reported
	// embeddings:warm ok=true. This asserts the leg's OWN health probe, not just the identity probe the
	// test above already covers.
	it("reports embeddings:warm UNHEALTHY when embedText resolves null, even though nothing threw", async () => {
		embedMock.mockResolvedValue(null);
		const { warmEmbeddings } = await import("./warm");
		await expect(warmEmbeddings()).resolves.toBeUndefined(); // still best-effort
		expect(recordProbeMock.mock.calls.find(([k]) => k === "embeddings:warm")?.[1]).toBe(false);
	});

	it("db: healthy on success, OUTAGE severity (the default) on failure", async () => {
		const { warmDb } = await import("./warm");
		await warmDb();
		expect(recordProbeMock.mock.calls[0]?.[0]).toBe("db:warm");
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);

		vi.resetModules();
		recordProbeMock.mockClear();
		executeMock.mockRejectedValue(new Error("pooler timeout"));
		const again = await import("./warm");
		await expect(again.warmDb()).resolves.toBeUndefined();
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
		expect(recordProbeMock.mock.calls[0]?.[2].severity).toBeUndefined(); // ⇒ "outage"
	});
});

describe("warmSyftCatalog — router catalog prewarm gating", () => {
	it("no-ops (no client, no SDK load) when the pre-flight router is off — the default", async () => {
		// cfg carries no RAG_ROUTER_* nor SYFTHUB_API_TOKEN → router gate closed; returns before the
		// dynamic syftCatalog import, so @syfthub/sdk never loads and nothing is fetched.
		const { warmSyftCatalog } = await import("./warm");
		await expect(warmSyftCatalog()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
		// A gated-off leg is not an unhealthy leg — reporting here would accumulate failures against a
		// dependency we deliberately never call, and eventually alert on nothing.
		expect(recordProbeMock).not.toHaveBeenCalled();
	});

	it("no-ops when the router is on but no SyftHub token is configured", async () => {
		cfg.RAG_ROUTER_ENABLED = "true";
		const { warmSyftCatalog } = await import("./warm");
		await expect(warmSyftCatalog()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("no-ops in shadow mode too when no token is configured (shadow still reads the catalog)", async () => {
		cfg.RAG_ROUTER_SHADOW = "true";
		const { warmSyftCatalog } = await import("./warm");
		await expect(warmSyftCatalog()).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// ── The catalog leg's OWN verdict, once both gates are open ─────────────────────────────
	// getSyftCatalog FAILS OPEN internally (syftCatalog.ts): client-acquisition failure, an aborted
	// browse, and an upstream error all resolve to `null` rather than throwing. A leg that only checked
	// for a throw would report ok=true on every one of those failures, so catalog:warm judges the result.
	it("reports catalog:warm HEALTHY when a catalog actually comes back", async () => {
		cfg.RAG_ROUTER_ENABLED = "true";
		cfg.SYFTHUB_API_TOKEN = "sk-warmtest";
		getSyftCatalogMock.mockResolvedValue({ sources: [{ id: "x" }] });
		const { warmSyftCatalog } = await import("./warm");
		await warmSyftCatalog();
		expect(recordProbeMock.mock.calls.find(([k]) => k === "catalog:warm")?.[1]).toBe(true);
	});

	it("reports catalog:warm UNHEALTHY when getSyftCatalog resolves null, even though nothing threw", async () => {
		cfg.RAG_ROUTER_ENABLED = "true";
		cfg.SYFTHUB_API_TOKEN = "sk-warmtest";
		getSyftCatalogMock.mockResolvedValue(null);
		const { warmSyftCatalog } = await import("./warm");
		await expect(warmSyftCatalog()).resolves.toBeUndefined(); // still best-effort
		expect(recordProbeMock.mock.calls.find(([k]) => k === "catalog:warm")?.[1]).toBe(false);
	});
});

describe("warmDeclineRate — the fail-closed child-safety decline alert", () => {
	it("reports HEALTHY below the threshold", async () => {
		countDeclinesMock.mockResolvedValue(4); // threshold is 5
		const { warmDeclineRate } = await import("./warm");
		await warmDeclineRate();
		expect(recordProbeMock.mock.calls[0]?.[0]).toBe("moderation:failclosed");
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("reports UNHEALTHY at the threshold, and as an OUTAGE not a degradation", async () => {
		countDeclinesMock.mockResolvedValue(5);
		const { warmDeclineRate } = await import("./warm");
		await warmDeclineRate();
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
		// Users are being refused — this is not a "still answering, just worse" case.
		expect(recordProbeMock.mock.calls[0]?.[2].severity).toBeUndefined();
	});

	// The trap this probe exists to close, applied to the probe itself: a count that FAILED must not
	// record a healthy zero, or the alert goes permanently green exactly when the DB is unhappy.
	it("reports NOTHING when the count query fails, rather than a healthy zero", async () => {
		countDeclinesMock.mockRejectedValue(new Error("relation does not exist"));
		const { warmDeclineRate } = await import("./warm");
		await expect(warmDeclineRate()).resolves.toBeUndefined(); // still best-effort
		expect(recordProbeMock).not.toHaveBeenCalled();
	});

	it("reports NOTHING on a throttle skip (a skipped probe must not reset the failure count)", async () => {
		countDeclinesMock.mockResolvedValue(99);
		const { warmDeclineRate } = await import("./warm");
		await warmDeclineRate();
		await warmDeclineRate(); // inside the 5-min throttle
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
	});
});

describe("warmCoopHealth — Coop is the REVIEW plane, never a detector (coop-review-plane Step 1e)", () => {
	it("deployed, Coop review keys unset: coop:review-config alerts unhealthy and names the keys", async () => {
		isDeploymentMock.mockReturnValue(true);
		coopReviewConfigMissingMock.mockReturnValue(["COOP_URL", "COOP_API_KEY"]);
		const { warmCoopHealth } = await import("./warm");
		await warmCoopHealth();
		const call = recordProbeMock.mock.calls.find((c) => c[0] === "coop:review-config");
		expect(call?.[1]).toBe(false);
		expect(call?.[2].runbook).toContain("COOP_URL, COOP_API_KEY");
	});
	it("deployed, every Coop review key set: coop:review-config reports healthy", async () => {
		isDeploymentMock.mockReturnValue(true);
		coopReviewConfigMissingMock.mockReturnValue([]);
		const { warmCoopHealth } = await import("./warm");
		await warmCoopHealth();
		expect(recordProbeMock.mock.calls.find((c) => c[0] === "coop:review-config")?.[1]).toBe(true);
	});
	it("off a deployment: no coop:review-config probe (local dev may leave Coop unset)", async () => {
		isDeploymentMock.mockReturnValue(false);
		coopReviewConfigMissingMock.mockReturnValue(["COOP_URL"]);
		const { warmCoopHealth } = await import("./warm");
		await warmCoopHealth();
		expect(recordProbeMock.mock.calls.some((c) => c[0] === "coop:review-config")).toBe(false);
	});
	it("origin ping only (warmModeration), ZERO coop:verdict alert, with no flag read", async () => {
		const { warmCoopHealth } = await import("./warm");
		await warmCoopHealth();
		expect(warmModerationMock).toHaveBeenCalledTimes(1); // the rule-free origin ping stands in
		expect(recordProbeMock.mock.calls.some((c) => c[0] === "coop:verdict")).toBe(false);
	});
});

describe("warmGuardHealth — the guard screens every chat turn, so its leg runs on every hosted build", () => {
	const healthyProbe = {
		healthy: true,
		transportOk: true,
		parseOk: true,
		identityOk: true,
		identityAsserted: true,
		servedModels: ["mistralai/Shieldstral-1.0-3B"],
	};

	it("a hosted build probes the guard with no flag and no agent screen token: the identity probe runs and records", async () => {
		guardPrimaryConfiguredMock.mockReturnValue(true);
		probeGuardHealthMock.mockResolvedValue(healthyProbe);
		const { warmGuardHealth } = await import("./warm");
		await warmGuardHealth();
		expect(probeGuardHealthMock).toHaveBeenCalledTimes(1);
		expect(recordProbeMock.mock.calls.find((c) => c[0] === "guard:verdict")?.[1]).toBe(true);
	});

	it("a hosted build with GUARD_SHADOW_URL unset: loud UNHEALTHY, never a silent skip", async () => {
		guardPrimaryConfiguredMock.mockReturnValue(false); // GUARD_SHADOW_URL unset
		const { warmGuardHealth } = await import("./warm");
		await warmGuardHealth();
		expect(probeGuardHealthMock).not.toHaveBeenCalled(); // cannot probe an unset endpoint
		const guardAlerts = recordProbeMock.mock.calls.filter((c) => c[0] === "guard:verdict");
		expect(guardAlerts).toHaveLength(1);
		expect(guardAlerts[0]![1]).toBe(false); // recorded UNHEALTHY
	});

	it("a self-host edition with no Shieldstral endpoint chose to run none: no probe, no alert", async () => {
		isSelfHostEditionMock.mockReturnValue(true);
		guardPrimaryConfiguredMock.mockReturnValue(false);
		const { warmGuardHealth } = await import("./warm");
		await warmGuardHealth();
		expect(probeGuardHealthMock).not.toHaveBeenCalled();
		expect(recordProbeMock.mock.calls.some((c) => c[0] === "guard:verdict")).toBe(false);
	});

	it("a self-host edition with no Shieldstral endpoint but the agent screen endpoint armed: loud UNHEALTHY, since agent screens fail closed", async () => {
		isSelfHostEditionMock.mockReturnValue(true);
		guardPrimaryConfiguredMock.mockReturnValue(false);
		safetyScreenTokenMock.mockReturnValue("agent-token");
		const { warmGuardHealth } = await import("./warm");
		await warmGuardHealth();
		const guardAlerts = recordProbeMock.mock.calls.filter((c) => c[0] === "guard:verdict");
		expect(guardAlerts).toHaveLength(1);
		expect(guardAlerts[0]![1]).toBe(false);
	});

	it("a self-host edition with a Shieldstral endpoint is probed like a hosted build", async () => {
		isSelfHostEditionMock.mockReturnValue(true);
		guardPrimaryConfiguredMock.mockReturnValue(true);
		probeGuardHealthMock.mockResolvedValue(healthyProbe);
		const { warmGuardHealth } = await import("./warm");
		await warmGuardHealth();
		expect(probeGuardHealthMock).toHaveBeenCalledTimes(1);
		expect(recordProbeMock.mock.calls.some((c) => c[0] === "guard:verdict")).toBe(true);
	});
});

describe("warmS1Health — the S1 judge's verdict path, watched while s1-safety-judge is on", () => {
	const s1Judge = vi.fn();
	const probe = (over: Record<string, unknown> = {}) => ({
		healthy: true,
		transportOk: true,
		parseOk: true,
		identityOk: true,
		identityAsserted: true,
		servedModels: ["zentropi-ai/cope-b-s1"],
		...over,
	});
	const s1Records = () => recordProbeMock.mock.calls.filter((c) => c[0] === "s1:verdict");
	const s1LegLine = () =>
		[...loggerInfoMock.mock.calls, ...loggerWarnMock.mock.calls, ...loggerErrorMock.mock.calls].find(
			(c) => (c[0] as { leg?: string })?.leg === "s1"
		);

	it("flag on and healthy: probes the S1 judge itself and records s1:verdict healthy, logging the served model", async () => {
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(probe());
		const { warmS1Health } = await import("./warm");
		await warmS1Health();
		expect(probeS1HealthMock).toHaveBeenCalledWith(s1Judge);
		expect(s1Records()).toHaveLength(1);
		expect(s1Records()[0]![1]).toBe(true);
		expect(s1LegLine()?.[0]).toMatchObject({ leg: "s1", ok: true, servedModels: ["zentropi-ai/cope-b-s1"] });
	});

	it.each([
		["a transport failure", { healthy: false, transportOk: false }],
		["the benign fixture blocking or the violative one passing", { healthy: false, parseOk: false }],
		["a served model that is not S1, or a missing model id", { healthy: false, identityOk: false, identityAsserted: false }],
	])("flag on and the probe red for %s: records s1:verdict UNHEALTHY with a warn line naming the failed check", async (_name, over) => {
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(probe(over));
		const { warmS1Health } = await import("./warm");
		await warmS1Health();
		expect(s1Records()).toHaveLength(1);
		expect(s1Records()[0]![1]).toBe(false);
		expect(loggerWarnMock.mock.calls.some((c) => (c[0] as { leg?: string }).leg === "s1")).toBe(true);
		const { healthy: _healthy, ...checks } = over;
		expect(s1LegLine()?.[0]).toMatchObject({ leg: "s1", ok: false, ...checks });
	});

	it("flag on with the S1 key or endpoint unset: loud UNHEALTHY (error line + exception + red record), never a silent skip", async () => {
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(null);
		const { warmS1Health } = await import("./warm");
		await warmS1Health();
		expect(s1Records()).toHaveLength(1);
		expect(s1Records()[0]![1]).toBe(false);
		expect(loggerErrorMock.mock.calls.some((c) => (c[0] as { leg?: string }).leg === "s1")).toBe(true);
		expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
	});

	it("flag off: the leg does not probe and records nothing, so it is never red", async () => {
		s1JudgeForMock.mockReturnValue(undefined);
		const { warmS1Health } = await import("./warm");
		await warmS1Health();
		expect(probeS1HealthMock).not.toHaveBeenCalled();
		expect(s1Records()).toHaveLength(0);
		expect(s1LegLine()).toBeUndefined();
	});

	it("throttled like the guard leg: a second call inside the window sends no second probe to the shared endpoint", async () => {
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(probe());
		const { warmS1Health } = await import("./warm");
		await warmS1Health();
		await warmS1Health();
		expect(probeS1HealthMock).toHaveBeenCalledTimes(1);
	});

	it("the Shieldstral guard leg is unchanged beside it: same probe, same guard:verdict record, whatever S1 reports", async () => {
		guardPrimaryConfiguredMock.mockReturnValue(true);
		probeGuardHealthMock.mockResolvedValue(probe({ servedModels: ["mistralai/Shieldstral-1.0-3B"] }));
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(probe({ healthy: false, transportOk: false }));
		const { warmGuardHealth, warmS1Health } = await import("./warm");
		await Promise.all([warmGuardHealth(), warmS1Health()]);
		expect(probeGuardHealthMock).toHaveBeenCalledTimes(1);
		expect(probeGuardHealthMock).toHaveBeenCalledWith();
		const guard = recordProbeMock.mock.calls.filter((c) => c[0] === "guard:verdict");
		expect(guard).toHaveLength(1);
		expect(guard[0]![1]).toBe(true);
		expect(guard[0]![2].label).toBe("Guard gate (Shieldstral-1.0-3B) verdict path");
		expect(s1Records()[0]![1]).toBe(false);
	});

	it("the scheduled job runs the S1 leg; the page ping never does", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		s1JudgeForMock.mockReturnValue(s1Judge);
		probeS1HealthMock.mockResolvedValue(probe());
		vi.stubEnv("VERCEL", "1");
		const { warmAll, warmPagePing } = await import("./warm");
		await warmPagePing();
		expect(probeS1HealthMock).not.toHaveBeenCalled();
		await warmAll();
		expect(probeS1HealthMock).toHaveBeenCalledTimes(1);
		vi.unstubAllEnvs();
	});
});

describe("warmAll — the cron is the only thing that KEEPS the flag snapshot and registry fresh", () => {
	// This is a WIRING test: flags.ts's header says the warm cron refreshes its snapshot, so something must
	// call refreshFlags — otherwise every flag reads its env fallback forever while the plane reports no
	// error, a flag plane that cannot go red. Reads are sync snapshot lookups, so if this call is dropped no
	// flag test fails: only this one does. the snapshot can stay fresh while the REGISTRY built from
	// it doesn't, so this also asserts the registry-gates leg runs every tick.
	it("calls refreshRegistryGatesIfChanged", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmAll } = await import("./warm");
		await warmAll();
		expect(refreshRegistryGatesIfChangedMock).toHaveBeenCalledTimes(1);
	});

	it("still completes when the registry-gates refresh rejects — a flag-plane outage is not a warm failure", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		refreshRegistryGatesIfChangedMock.mockRejectedValueOnce(new Error("posthog unreachable"));
		const { warmAll } = await import("./warm");
		await expect(warmAll()).resolves.toBeUndefined();
	});
});

describe("external heartbeat — the dead-man's switch that survives us being down", () => {
	const HEARTBEAT = "https://uptime.betterstack.com/api/v1/heartbeat/testtoken";

	it("pings the configured URL once per warm run", async () => {
		cfg.BETTERSTACK_HEARTBEAT_URL = HEARTBEAT;
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		const { warmAll } = await import("./warm");
		await warmAll();
		const pings = fetchMock.mock.calls.filter(([u]) => String(u) === HEARTBEAT);
		expect(pings).toHaveLength(1);
		expect((pings[0]![1] as RequestInit).method).toBe("POST");
	});

	// PROD ONLY by configuration. If preview also pinged prod's heartbeat, preview could hold it green
	// while prod was dead — a check that cannot go red for the one case it exists for. The unset case
	// must therefore be silent, not an error.
	it("pings NOTHING when the URL is unset (preview/local) and does not treat that as a failure", async () => {
		delete cfg.BETTERSTACK_HEARTBEAT_URL;
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmAll } = await import("./warm");
		await expect(warmAll()).resolves.toBeUndefined();
		expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("heartbeat"))).toHaveLength(0);
	});

	// The regression this guards: fetch RESOLVES on 4xx/5xx, so a rotated or revoked heartbeat URL would
	// otherwise log ok=true forever — the same shape as the model leg staying green through a WAF 403.
	it("treats a non-2xx from Better Stack as a failure rather than a successful ping", async () => {
		cfg.BETTERSTACK_HEARTBEAT_URL = HEARTBEAT;
		fetchMock.mockImplementation(async (u: string) =>
			String(u) === HEARTBEAT ? new Response("gone", { status: 404 }) : new Response("{}", { status: 200 })
		);
		const { warmAll } = await import("./warm");
		// Still best-effort: a Better Stack failure must not break the cron everything else rides on.
		await expect(warmAll()).resolves.toBeUndefined();
	});

	it("completes the warm run even when the heartbeat endpoint is unreachable", async () => {
		cfg.BETTERSTACK_HEARTBEAT_URL = HEARTBEAT;
		fetchMock.mockImplementation(async (u: string) => {
			if (String(u) === HEARTBEAT) throw new Error("ECONNREFUSED");
			return new Response("{}", { status: 200 });
		});
		const { warmAll } = await import("./warm");
		await expect(warmAll()).resolves.toBeUndefined();
	});
});

// The only probe that watches OUR code rather than a dependency. Every other leg reports on a vendor;
// a per-route config split in our own tree is something no vendor probe sees.
describe("warmErrorRate — unhandled server exceptions", () => {
	it("reports HEALTHY below the threshold", async () => {
		takeErrorCountMock.mockReturnValue(4); // threshold is 5
		const { warmErrorRate } = await import("./warm");
		await warmErrorRate();
		expect(recordProbeMock.mock.calls[0]?.[0]).toBe("errors:rate");
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("reports UNHEALTHY at the threshold, as an OUTAGE not a degradation", async () => {
		takeErrorCountMock.mockReturnValue(5);
		const { warmErrorRate } = await import("./warm");
		await warmErrorRate();
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
		// Exceptions are not a "still answering, just worse" case, so no degraded wording.
		expect(recordProbeMock.mock.calls[0]?.[2].severity).toBeUndefined();
	});

	// Load-bearing: a probe that only reported when OVER could never clear a firing alert, so the
	// channel would stay red after recovery and get muted. recordProbe posts the recovery line on a
	// healthy probe — which only happens if we report every tick, zero included.
	it("reports on a ZERO tick too, which is what clears a firing alert", async () => {
		takeErrorCountMock.mockReturnValue(0);
		const { warmErrorRate } = await import("./warm");
		await warmErrorRate();
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("drains the counter exactly once per tick, so the value is a rate and not a total", async () => {
		takeErrorCountMock.mockReturnValue(1);
		const { warmErrorRate } = await import("./warm");
		await warmErrorRate();
		expect(takeErrorCountMock).toHaveBeenCalledTimes(1);
	});
});

// The auto-route classifier fails OPEN (answers normally) rather than throwing, so
// warmErrorRate's own counter never sees it — this leg exists because that failure mode was
// otherwise invisible to every other probe in this file.
describe("warmAgentRouteFailureRate — auto-route classifier fail-open rate", () => {
	it("reports HEALTHY below the threshold", async () => {
		takeAgentRouteFailureCountMock.mockReturnValue(4); // threshold is 5
		const { warmAgentRouteFailureRate } = await import("./warm");
		await warmAgentRouteFailureRate();
		expect(recordProbeMock.mock.calls[0]?.[0]).toBe("agent-route:failure-rate");
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("reports UNHEALTHY at the threshold", async () => {
		takeAgentRouteFailureCountMock.mockReturnValue(5);
		const { warmAgentRouteFailureRate } = await import("./warm");
		await warmAgentRouteFailureRate();
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(false);
	});

	// Load-bearing for the same reason as the error-rate leg above: a probe that only reports
	// when unhealthy can never clear a firing alert once the classifier recovers.
	it("reports on a ZERO tick too, which is what clears a firing alert", async () => {
		takeAgentRouteFailureCountMock.mockReturnValue(0);
		const { warmAgentRouteFailureRate } = await import("./warm");
		await warmAgentRouteFailureRate();
		expect(recordProbeMock).toHaveBeenCalledTimes(1);
		expect(recordProbeMock.mock.calls[0]?.[1]).toBe(true);
	});

	it("drains the counter exactly once per tick, so the value is a rate and not a total", async () => {
		takeAgentRouteFailureCountMock.mockReturnValue(1);
		const { warmAgentRouteFailureRate } = await import("./warm");
		await warmAgentRouteFailureRate();
		expect(takeAgentRouteFailureCountMock).toHaveBeenCalledTimes(1);
	});
});

describe("warmTurnOutcomeRate — burn rate split by the layer each failed turn died in", () => {
	const call = (key: string) => recordProbeMock.mock.calls.find(([k]) => k === key);
	type W = OutcomeAgg["counts"];
	/** `n` turns in every window: they all happened in the last five minutes. */
	const now = (n: number): W => ({ "5m": n, "30m": n, "1h": n, "6h": n });
	/** `n` turns more than an hour ago, inside the 6h window only. */
	const earlier = (n: number): W => ({ "5m": 0, "30m": 0, "1h": 0, "6h": n });
	const row = (outcome: string, failureLayer: string | null, counts: W, model = "mistral-large-2512"): OutcomeAgg => ({
		outcome,
		failureLayer,
		model,
		counts,
	});
	const run = async (rows: OutcomeAgg[]) => {
		countTurnOutcomeWindowsMock.mockResolvedValue(rows);
		const { warmTurnOutcomeRate } = await import("./warm");
		await warmTurnOutcomeRate();
	};

	// THE contract, stated in the name: this must go RED when our own pipeline fails a share of turns now.
	it("pages (turn:outcome-rate unhealthy, DOWN) when failures in OUR layer burn fast in both the 5m and 1h windows", async () => {
		await run([row("complete", null, now(20)), row("error", "ours", now(5))]);
		expect(call("turn:outcome-rate")?.[1]).toBe(false);
		expect(call("turn:outcome-rate")?.[2]).not.toHaveProperty("severity", "degraded");
	});

	it("does NOT page on a saturated partner host: upstream failures stay off turn:outcome-rate and name the model on turn:upstream-rate", async () => {
		const sealion = "aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B";
		await run([row("complete", null, now(20)), row("timedOut", "upstream", now(5), sealion)]);
		expect(call("turn:outcome-rate")?.[1]).toBe(true);
		expect(call("turn:upstream-rate")?.[1]).toBe(false);
		expect(call("turn:upstream-rate")?.[2]).toMatchObject({ severity: "degraded" });
		expect(String(call("turn:upstream-rate")?.[2].label)).toContain(sealion);
	});

	it("reports visitor harm (degraded) when upstream failures leave visitors without an answer, though our layer is clean", async () => {
		// The harm SLO (95%) carries the week's 3.5% partner-host failures, so a fast burn is 72% failing.
		await run([row("complete", null, now(5)), row("error", "upstream", now(20))]);
		expect(call("turn:harm-rate")?.[1]).toBe(false);
		expect(call("turn:harm-rate")?.[2]).toMatchObject({ severity: "degraded" });
	});

	it("counts a failure with NO layer (a row written before the column) as ours, so nothing unattributed drops out", async () => {
		await run([row("complete", null, now(20)), row("timedOut", null, now(5))]);
		expect(call("turn:outcome-rate")?.[1]).toBe(false);
	});

	it("counts empty turns as failures — the model answered none of them", async () => {
		await run([row("complete", null, now(20)), row("empty", "ours", now(5))]);
		expect(call("turn:outcome-rate")?.[1]).toBe(false);
	});

	it("counts client-layer failures on no alert: a visitor's own local endpoint is not our outage or a partner's", async () => {
		await run([row("complete", null, now(20)), row("timedOut", "client", now(5), "local:abc:qwen")]);
		expect(call("turn:outcome-rate")?.[1]).toBe(true);
		expect(call("turn:harm-rate")?.[1]).toBe(true);
	});

	it("does NOT count user-aborts or policy-declines as failures", async () => {
		await run([
			row("complete", null, now(9)),
			row("aborted", "client", now(40)),
			row("declined", null, now(10)),
			row("error", "ours", now(1)),
		]);
		expect(call("turn:outcome-rate")?.[1]).toBe(true);
	});

	it("records NOTHING below the volume floor — 1 failed turn of 2 is not a 50% outage", async () => {
		await run([row("complete", null, now(1)), row("error", "ours", now(1))]);
		expect(call("turn:outcome-rate")).toBeUndefined();
		expect(call("turn:harm-rate")).toBeUndefined();
	});

	it("records NOTHING when the count query throws — no healthy zero (the always-green trap)", async () => {
		countTurnOutcomeWindowsMock.mockRejectedValue(new Error("db down"));
		const { warmTurnOutcomeRate } = await import("./warm");
		await warmTurnOutcomeRate();
		expect(call("turn:outcome-rate")).toBeUndefined();
	});

	// The problem, solved by the short window: a burst that ended stops paging within minutes once
	// answers complete again, and silence alone clears nothing.
	describe("recovery is read from the short window", () => {
		const burstInTheHour = (short: W) => [
			row("complete", null, { "5m": short["5m"], "30m": 20, "1h": 20, "6h": 20 }),
			row("timedOut", "ours", { "5m": 0, "30m": 6, "1h": 6, "6h": 6 }),
		];

		it("records HEALTHY once the last 5 minutes hold completed turns and no failure, though the hour is still over", async () => {
			await run(burstInTheHour({ ...earlier(0), "5m": 3 }));
			expect(call("turn:outcome-rate")?.[1]).toBe(true);
		});

		it("records NOTHING when the last 5 minutes hold no turn at all — silence is not evidence of health", async () => {
			await run(burstInTheHour(earlier(0)));
			expect(call("turn:outcome-rate")).toBeUndefined();
		});
	});

	it("keeps a slow 6h burn on its own degraded probe, not the page", async () => {
		// 4 failures among 50 turns over 6h (8%, 16x on a 0.5% budget), the last 30 minutes still failing.
		await run([
			row("complete", null, { "5m": 5, "30m": 10, "1h": 20, "6h": 46 }),
			row("error", "ours", { "5m": 0, "30m": 2, "1h": 2, "6h": 4 }),
		]);
		expect(call("turn:outcome-burn-slow")?.[1]).toBe(false);
		expect(call("turn:outcome-burn-slow")?.[2]).toMatchObject({ severity: "degraded" });
		expect(call("turn:outcome-rate")?.[1]).toBe(true);
	});

	it("prunes the table on a run that read it, so it never grows unbounded", async () => {
		await run([row("complete", null, now(50)), row("error", "ours", now(1))]);
		expect(pruneTurnOutcomesMock).toHaveBeenCalledTimes(1);
	});
});

describe("warmTurnSpeed — answers that arrive, slowly", () => {
	const speedCall = () => recordProbeMock.mock.calls.find(([k]) => k === "turn:first-token-median");
	const turns = (ms: number) => Array.from({ length: 15 }, () => ms);

	it("reports HEALTHY when the newest 15 completed turns' median first token is under 15s", async () => {
		recentCompleteTtftsMock.mockResolvedValue(turns(3_000));
		const { warmTurnSpeed } = await import("./warm");
		await warmTurnSpeed();
		expect(speedCall()?.[1]).toBe(true);
	});

	// The contract: every turn completes and nothing errors, so the outcome-rate probe stays green. This
	// one has to go red on the wait alone.
	it("reports UNHEALTHY when every turn completes but the median first token is over 15s", async () => {
		recentCompleteTtftsMock.mockResolvedValue(turns(22_000));
		const { warmTurnSpeed } = await import("./warm");
		await warmTurnSpeed();
		expect(speedCall()?.[1]).toBe(false);
	});

	it("records NOTHING below 15 completed turns, so a quiet night neither raises nor clears it", async () => {
		recentCompleteTtftsMock.mockResolvedValue(turns(40_000).slice(0, 14));
		const { warmTurnSpeed } = await import("./warm");
		await warmTurnSpeed();
		expect(speedCall()).toBeUndefined();
	});

	it("records NOTHING when the read throws — a failed read is not a fast answer", async () => {
		recentCompleteTtftsMock.mockRejectedValue(new Error("db down"));
		const { warmTurnSpeed } = await import("./warm");
		await warmTurnSpeed();
		expect(speedCall()).toBeUndefined();
	});
});

// An unreadable Mistral model list credits every answer to the router's `*-latest` alias, and
// on event instances that runs for hours with only an error log line. The leg turns it into an alert.
describe("warmMistralVersions — the answer-version list", () => {
	const routerLane = () =>
		Object.assign(cfg, {
			MISTRAL_CHAT_BASE_URL: "https://router.example.test/v1",
			MISTRAL_CHAT_API_KEY: "router-key",
		});

	it("records mistral:versions unhealthy when the router refuses the list", async () => {
		routerLane();
		fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
		const { warmMistralVersions } = await import("./warm");
		await warmMistralVersions();
		expect(recordProbeMock).toHaveBeenCalledWith(
			"mistral:versions",
			false,
			expect.objectContaining({ severity: "degraded" })
		);
	});

	it("records mistral:versions healthy when the router lists the models", async () => {
		routerLane();
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: "mistral-large-latest", aliases: ["mistral-large-2512"] }] }), {
				status: 200,
			})
		);
		const { warmMistralVersions } = await import("./warm");
		await warmMistralVersions();
		expect(fetchMock.mock.calls[0]?.[0]).toBe("https://router.example.test/mistral/v1/models");
		expect(recordProbeMock).toHaveBeenCalledWith("mistral:versions", true, expect.anything());
	});

	it("records nothing and calls nothing on a deployment with no Mistral lane", async () => {
		const { warmMistralVersions } = await import("./warm");
		await warmMistralVersions();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(recordProbeMock).not.toHaveBeenCalledWith("mistral:versions", expect.anything(), expect.anything());
	});
});

// the legs split by who needs them. A page ping wakes upstreams and never drives alerting;
// a process's own keepalive refreshes its state; the scheduled job (warmAll) runs everything.
describe("warm groups — page ping, process keepalive, scheduled job", () => {
	const deploymentLegsRan = () =>
		countDeclinesMock.mock.calls.length + countTurnOutcomeWindowsMock.mock.calls.length;
	const processLegsRan = () =>
		executeMock.mock.calls.length + refreshRegistryGatesIfChangedMock.mock.calls.length + takeErrorCountMock.mock.calls.length;

	afterEach(() => vi.unstubAllEnvs());

	it("the page ping off Vercel wakes moderation and the model, and runs no process or deployment leg", async () => {
		vi.stubEnv("VERCEL", "");
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmPagePing } = await import("./warm");
		await warmPagePing();
		expect(warmModerationMock).toHaveBeenCalledTimes(1);
		expect(processLegsRan()).toBe(0);
		expect(deploymentLegsRan()).toBe(0);
	});

	it("the page ping on Vercel also refreshes this instance's state, since Vercel has no keepalive, but still runs no probe", async () => {
		vi.stubEnv("VERCEL", "1");
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmPagePing } = await import("./warm");
		await warmPagePing();
		expect(warmModerationMock).toHaveBeenCalledTimes(1);
		expect(refreshRegistryGatesIfChangedMock).toHaveBeenCalledTimes(1);
		expect(executeMock).toHaveBeenCalledTimes(1);
		expect(takeErrorCountMock).toHaveBeenCalledTimes(1);
		expect(deploymentLegsRan()).toBe(0);
	});

	it("a process's keepalive refreshes its flags, registry, DB connection and error counters, and nothing else", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmProcess } = await import("./warm");
		await warmProcess();
		expect(refreshRegistryGatesIfChangedMock).toHaveBeenCalledTimes(1);
		expect(executeMock).toHaveBeenCalledTimes(1);
		expect(takeErrorCountMock).toHaveBeenCalledTimes(1);
		expect(takeAgentRouteFailureCountMock).toHaveBeenCalledTimes(1);
		expect(warmModerationMock).not.toHaveBeenCalled();
		expect(deploymentLegsRan()).toBe(0);
	});

	it("the scheduled job runs all three groups", async () => {
		fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
		const { warmAll } = await import("./warm");
		await warmAll();
		// The page leg's ping and the Coop leg's origin ping (warmModeration throttles itself).
		expect(warmModerationMock).toHaveBeenCalledTimes(2);
		expect(refreshRegistryGatesIfChangedMock).toHaveBeenCalledTimes(1);
		expect(countDeclinesMock).toHaveBeenCalledTimes(1);
		expect(countTurnOutcomeWindowsMock).toHaveBeenCalledTimes(1);
	});
});

describe("warmAgentTokenExpiry — the agent token's exp, read before agent mode stops", () => {
	const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
	const tokenExpiringIn = (days: number) =>
		`${b64({ alg: "HS256" })}.${b64({ exp: Math.floor(Date.now() / 1000 + days * 86_400) })}.c2ln`;

	it("goes unhealthy (degraded) when 21 days or fewer are left on the token", async () => {
		cfg.AGENT_SERVICE_TOKEN = tokenExpiringIn(20);
		const { warmAgentTokenExpiry } = await import("./warm");
		await warmAgentTokenExpiry();
		const call = recordProbeMock.mock.calls.find(([key]) => key === "agent:token-expiry");
		expect(call?.[1]).toBe(false);
		expect(call?.[2].severity).toBe("degraded");
		expect(call?.[2].runbook).not.toContain(cfg.AGENT_SERVICE_TOKEN);
	});

	it("stays healthy with more than 21 days left", async () => {
		cfg.AGENT_SERVICE_TOKEN = tokenExpiringIn(58);
		const { warmAgentTokenExpiry } = await import("./warm");
		await warmAgentTokenExpiry();
		expect(recordProbeMock).toHaveBeenCalledWith("agent:token-expiry", true, expect.anything());
	});

	it("records nothing when there is no token or it has no exp", async () => {
		const { warmAgentTokenExpiry } = await import("./warm");
		await warmAgentTokenExpiry();
		cfg.AGENT_SERVICE_TOKEN = "opaque-self-host-token";
		vi.resetModules();
		const fresh = await import("./warm");
		await fresh.warmAgentTokenExpiry();
		expect(recordProbeMock).not.toHaveBeenCalledWith("agent:token-expiry", expect.anything(), expect.anything());
	});
});

describe("warmProcess — each process logs its own flag refresh", () => {
	afterEach(() => {
		flagsOverride.configured = undefined;
		flagsOverride.refresh = undefined;
		flagsOverride.state = undefined;
	});

	const flagLines = () =>
		[...loggerInfoMock.mock.calls, ...loggerWarnMock.mock.calls].filter(
			(c) => (c[0] as { leg?: string })?.leg === "flags"
		);

	it("logs one flags line per tick with this process's pid when the refresh lands", async () => {
		flagsOverride.configured = true;
		flagsOverride.refresh = async () => {};
		flagsOverride.state = { polledOk: true, lastRefreshAt: Date.now(), size: 7 };
		const { warmProcess } = await import("./warm");
		await warmProcess();
		const lines = flagLines();
		expect(lines).toHaveLength(1);
		expect(lines[0][0]).toMatchObject({ leg: "flags", ok: true, pid: process.pid, flagCount: 7 });
	});

	it("reports ok=false when the poll failed and the snapshot is stale", async () => {
		flagsOverride.configured = true;
		flagsOverride.refresh = async () => {};
		flagsOverride.state = { polledOk: true, lastRefreshAt: Date.now() - 10 * 60_000, size: 7 };
		const { warmProcess } = await import("./warm");
		await warmProcess();
		expect(flagLines()[0][0]).toMatchObject({ leg: "flags", ok: false });
	});

	it("logs nothing with PostHog unset, where flags read the self-host defaults", async () => {
		flagsOverride.configured = false;
		const { warmProcess } = await import("./warm");
		await warmProcess();
		expect(flagLines()).toHaveLength(0);
	});
});

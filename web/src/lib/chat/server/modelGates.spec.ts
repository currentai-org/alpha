import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// WHAT THIS PINS. Two contracts that look identical when they break, which is why they need naming.
//
// 1. THE POLL COMES FIRST. The registry builds once per instance and caches whatever the gates said.
//    Read a gate against a cold-start snapshot and the answer is the fallback (off), cached for the
//    instance's whole life — in preview, which has no warm cron, that is EVERY build. A flag that has
//    been turned on then reports as off, and "the flag is off" and "the flag was never read" are the
//    same observable. So the order is asserted directly, not assumed from the shape of the code.
//
// 2. OFF IS ONE MODEL, NOT ZERO. `offeredModels` narrows the allowlisted set; with the picker off it
//    must keep exactly the first entry. Returning [] would take the registry to empty, which
//    publishRegistry rejects and which would 500 every route — a fail-open gate's opposite number, and
//    just as much a reason to say what the number is rather than that it is "narrowed".
//
// Both gates fall back OFF, so the tests below leave a key unanswered where the fallback is what is
// under test — the mock delegates to the caller's thunk exactly as flagEnabledOr does.

const h = vi.hoisted(() => ({
	/** Every refresh and every flag read, in the order they happened. */
	calls: [] as string[],
	/** Keys PostHog "defines" for a given test. An absent key falls through to the caller's fallback. */
	answers: new Map<string, boolean>(),
	/** Backing store for the mocked config Proxy — unset keys read "", as the real one does. */
	env: {} as Record<string, string>,
	/** Whether a poll has returned flags yet, and who waits on the first one (whenFlagsPolled). */
	polled: false,
	waiters: [] as Array<() => unknown>,
}));

vi.mock("$lib/chat/server/config", () => ({
	config: new Proxy(
		{},
		{ get: (_t, prop) => (typeof prop === "string" ? (h.env[prop] ?? "") : "") }
	),
	ready: Promise.resolve(),
}));

vi.mock("$lib/chat/server/flags", () => ({
	refreshFlags: vi.fn(async () => {
		h.calls.push("refreshFlags");
	}),
	// Honours the request's override cookie and account answers first, as the real flagEnabledOr does,
	// so a build inside a request can be checked for ignoring them (CUR-3701).
	flagEnabledOr: vi.fn((key: string, fallback: () => boolean) => {
		h.calls.push(`read:${key}`);
		const ctx = getRequestContext();
		const forced = ctx?.fuzzOverride?.[key] ?? ctx?.accountFlags?.get(key);
		if (forced !== undefined) return forced;
		const v = h.answers.get(key);
		return v === undefined ? fallback() : v;
	}),
	flagEnabledForUser: vi.fn(async () => undefined),
	whenFlagsPolled: vi.fn((fn: () => unknown) => {
		if (h.polled) return false;
		h.waiters.push(fn);
		return true;
	}),
}));

// What each build hands Vercel's waitUntil, so a test can see how long it keeps the instance awake.
const bg = vi.hoisted(() => ({ held: [] as Promise<unknown>[] }));
vi.mock("$lib/chat/server/vercelBackground", () => ({
	runInBackground: vi.fn(async (p: Promise<unknown>) => {
		bg.held.push(p);
	}),
}));

import { AGENT_MODE_FLAG } from "./agentMode";
import { getRequestContext, runWithRequestContext, updateRequestContext } from "./requestContext";
import { refreshFlags } from "./flags";
import {
	REGISTRY_POLL_CAP_MS,
	MODEL_PICKER_FLAG,
	ROUTER_ALIAS_FLAG,
	modelPickerEnabled,
	offeredModels,
	onRegistryPollLanded,
	resolveRegistryGates,
	routerAliasEnabled,
} from "./modelGates";
import { logger } from "./logger";
import { DEPLOYMENT_SCOPED_FLAG_KEYS } from "./flagKeys";

// agentModeEnabled() reads deployEnv() (process.env.DEPLOY_ENV / VERCEL_ENV) directly, not
// through the mocked `config`/`flags` modules above — this file didn't need to touch either var before
// that change, so without an explicit save/restore the `agent: false` assertions below would only hold
// by accident of whatever the test runner's ambient environment happens to be. Force non-preview by
// default; the one test that wants agent:true sets VERCEL_ENV itself. (CUR-770)
const savedDeployEnv = process.env.DEPLOY_ENV;
const savedVercelEnv = process.env.VERCEL_ENV;

beforeEach(() => {
	h.calls.length = 0;
	h.answers.clear();
	for (const k of Object.keys(h.env)) delete h.env[k];
	vi.restoreAllMocks();
	delete process.env.DEPLOY_ENV;
	process.env.VERCEL_ENV = "development";
});

afterEach(() => {
	if (savedDeployEnv === undefined) delete process.env.DEPLOY_ENV;
	else process.env.DEPLOY_ENV = savedDeployEnv;
	if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = savedVercelEnv;
});

// The registry is built once and shared by every visitor after, so each flag it reads must be
// marked deployment-scoped, or flagEnabledOr would hand it the answer of whichever account's request
// happened to build it. Read off the gates actually called, on preview where agent-mode is read too. (CUR-2463)
describe("resolveRegistryGates — every flag it reads is deployment-scoped", () => {
	it("reads no flag that a signed-in account's own answer could change", async () => {
		process.env.VERCEL_ENV = "preview";
		await resolveRegistryGates();
		const read = h.calls.filter((c) => c.startsWith("read:")).map((c) => c.slice(5));
		expect(read).toContain(AGENT_MODE_FLAG);
		expect(read.filter((k) => !DEPLOYMENT_SCOPED_FLAG_KEYS.has(k))).toEqual([]);
	});
});

describe("resolveRegistryGates — a poll that never settles cannot hold a cold instance", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// A cold instance must not sit in this poll until the 300s platform kill, with every request routed
	// to it 504ing behind it. Past the cap the gates must answer from what the instance already has.
	it("answers every gate from its fallback once the cap passes, with the poll still pending", async () => {
		vi.useFakeTimers();
		vi.mocked(refreshFlags).mockImplementationOnce(() => new Promise<void>(() => {}));
		let gates: Awaited<ReturnType<typeof resolveRegistryGates>> | undefined;
		void resolveRegistryGates().then((g) => {
			gates = g;
		});
		await vi.advanceTimersByTimeAsync(REGISTRY_POLL_CAP_MS - 1);
		expect(gates, "answered before the cap: the poll was not awaited at all").toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		expect(gates).toMatchObject({ picker: false, routerAlias: false, agent: false });
	});

	// The registry built from those fallbacks keeps them, and previews get no warm cron to re-check, so
	// the first poll that returns flags has to tell the registry (models.ts registers the rebuild). A
	// cold poll can also come back EMPTY inside the cap, because the SDK's definitions haven't loaded:
	// that leaves a preview on fallback gates for five minutes, so it is the case pinned first.
	it("tells the registry once a poll returns flags, after a build that read its gates before one had", async () => {
		// Earlier builds in this file left the module's one waiter queued: let it run, as a good poll would.
		for (const fn of h.waiters.splice(0)) await fn();
		const landed = vi.fn();
		onRegistryPollLanded(landed);
		h.polled = false;
		await resolveRegistryGates(); // settles inside the cap, but nothing has polled ok: fallbacks
		await resolveRegistryGates(); // a second build before the first poll lands adds no second waiter
		expect(h.waiters).toHaveLength(1);
		expect(landed).not.toHaveBeenCalled();
		h.polled = true;
		await h.waiters.splice(0)[0]();
		expect(landed).toHaveBeenCalledTimes(1);

		await resolveRegistryGates(); // gates read after a good poll are real: nothing to rebuild
		expect(h.waiters).toHaveLength(0);
	});

	// Vercel freezes an instance between invocations, and a frozen instance keeps one model until a
	// later request thaws it, so the build must hold the instance open until the
	// late poll lands and the rebuild it starts has finished, not just until the cap (CUR-4194).
	it("keeps the instance awake past the cap until the late poll lands and its rebuild finishes", async () => {
		for (const fn of h.waiters.splice(0)) await fn();
		h.polled = false;
		bg.held.length = 0;
		vi.useFakeTimers();
		let landPoll!: () => void;
		vi.mocked(refreshFlags).mockImplementationOnce(() =>
			new Promise<void>((r) => (landPoll = r)).then(() => {
				// as the real refreshFlags does: waiters are queued before the poll's own promise settles
				h.polled = true;
				for (const fn of h.waiters.splice(0)) void Promise.resolve().then(fn);
			})
		);
		let finishRebuild!: () => void;
		onRegistryPollLanded(() => new Promise<void>((r) => (finishRebuild = r)));

		const build = resolveRegistryGates();
		await vi.advanceTimersByTimeAsync(REGISTRY_POLL_CAP_MS);
		await build;
		expect(bg.held, "the build handed nothing to waitUntil").toHaveLength(1);
		let released = false;
		void bg.held[0].then(() => (released = true));

		landPoll();
		await vi.advanceTimersByTimeAsync(0);
		expect(finishRebuild, "the late poll did not start the rebuild").toBeTypeOf("function");
		expect(released, "the instance was let go before the rebuild finished").toBe(false);
		finishRebuild();
		await vi.advanceTimersByTimeAsync(0);
		expect(released).toBe(true);
	});
});

describe("resolveRegistryGates — the poll happens before any gate is read", () => {
	it("refreshes the flag snapshot FIRST, then reads every gate that depends on it", async () => {
		await resolveRegistryGates();

		expect(
			h.calls[0],
			"a gate was read before refreshFlags resolved. The registry build caches its answer for the " +
				"instance's whole life, so on a cold instance (always, in preview) every gate would pin to " +
				"its fallback and a flag that is ON would report as off."
		).toBe("refreshFlags");
		// agent isn't in this list because THIS test's env is development, and agentModeEnabled()
		// short-circuits on deployEnv() before it reads anything (CUR-770's check, still there). On
		// preview or production it does read `agent-mode` (CUR-1440) and does appear — asserted below.
		expect(h.calls.slice(1)).toEqual([
			`read:${MODEL_PICKER_FLAG}`,
			`read:${ROUTER_ALIAS_FLAG}`,
			"read:side-call-own-lane",
		]);
	});

	it("answers all three gates off when PostHog defines none of them and the env isn't preview", async () => {
		const gates = await resolveRegistryGates();
		expect(gates).toEqual({ picker: false, routerAlias: false, agent: false, sideCallLane: false });
	});

	it("carries each flag's answer through to its own field", async () => {
		h.env.LLM_ROUTER_ROUTES_PATH = "/policy/routes.json";
		h.answers.set(MODEL_PICKER_FLAG, true);
		h.answers.set(ROUTER_ALIAS_FLAG, true);

		const gates = await resolveRegistryGates();
		expect(gates).toEqual({ picker: true, routerAlias: true, agent: false, sideCallLane: false });
	});

	it("answers agent:true on preview with the flag on and a service URL configured", async () => {
		process.env.VERCEL_ENV = "preview";
		h.env.AGENT_SERVICE_URL = "https://agent.test";
		h.answers.set(AGENT_MODE_FLAG, true);

		const gates = await resolveRegistryGates();
		expect(gates.agent).toBe(true);
		// The read has to happen AFTER the poll, same as the other two. Before CUR-1440 the agent gate
		// took no part in the snapshot, so nothing here could have caught it being read too early.
		expect(h.calls.indexOf(`read:${AGENT_MODE_FLAG}`)).toBeGreaterThan(h.calls.indexOf("refreshFlags"));
	});

	it("ignores the building request's override cookie and account answers, since every visitor shares the result (CUR-3701)", async () => {
		process.env.VERCEL_ENV = "preview";
		h.env.AGENT_SERVICE_URL = "https://agent.test";
		h.answers.set(AGENT_MODE_FLAG, true);

		const gates = await runWithRequestContext(
			async () => {
				updateRequestContext({ accountFlags: new Map([[AGENT_MODE_FLAG, false]]) });
				return resolveRegistryGates();
			},
			{ fuzzOverride: { [AGENT_MODE_FLAG]: false } }
		);
		expect(
			gates.agent,
			"a spec's agent-mode:false cookie on a warm request rebuilt develop's registry without the " +
				"agent, and every agent turn on that instance answered on the selected model (CUR-3701)"
		).toBe(true);
	});

	it("answers agent:false on preview with a service URL configured but the flag OFF", async () => {
		process.env.VERCEL_ENV = "preview";
		h.env.AGENT_SERVICE_URL = "https://agent.test";
		h.answers.set(AGENT_MODE_FLAG, false);

		const gates = await resolveRegistryGates();
		expect(
			gates.agent,
			"the flag no longer decides whether agent mode is reachable — turning it off in PostHog " +
				"would leave the model registered and the composer toggle live, and hiding agent mode " +
				"would be back to needing a deploy (CUR-1440)."
		).toBe(false);
	});

	it("answers agent:false when PostHog defines no agent-mode flag, even on preview", async () => {
		process.env.VERCEL_ENV = "preview";
		h.env.AGENT_SERVICE_URL = "https://agent.test";

		const gates = await resolveRegistryGates();
		expect(
			gates.agent,
			"an absent flag has to fall back OFF. A cold instance and a deleted flag are the same " +
				"observable here, and the safe answer for both is to withhold the surface."
		).toBe(false);
	});
});

describe("offeredModels — with the picker off the registry keeps ONE model, not none", () => {
	const catalog = ["a", "b", "c"];

	it("keeps the first entry alone when the picker is off, whatever the allowlist admitted", () => {
		expect(
			offeredModels(catalog, false),
			"an empty result takes the registry to zero models, which publishRegistry rejects and which " +
				"500s every route"
		).toEqual(["a"]);
	});

	it("keeps every entry, in order, when the picker is on", () => {
		expect(offeredModels(catalog, true)).toEqual(["a", "b", "c"]);
	});

	it("does not invent a model when the allowlist admitted nothing", () => {
		expect(offeredModels([], false)).toEqual([]);
	});

	it("leaves models[0] — and therefore defaultModel — untouched by a flag flip", () => {
		expect(offeredModels(catalog, false)[0]).toBe(offeredModels(catalog, true)[0]);
	});
});

describe("modelPickerEnabled — MODEL_ALLOWLIST is config, this is the switch", () => {
	it("is off when PostHog does not define the key", () => {
		expect(modelPickerEnabled()).toBe(false);
	});

	it("is on when the flag is on, without touching MODEL_ALLOWLIST", () => {
		h.env.MODEL_ALLOWLIST = "swiss-ai/apertus-v1.5-70b";
		h.answers.set(MODEL_PICKER_FLAG, true);
		expect(modelPickerEnabled()).toBe(true);
	});
});

describe("routerAliasEnabled — the routes path is config, the flag is the switch", () => {
	it("is off with the policy PRESENT and the flag off — the state the old gate could not express", () => {
		h.env.LLM_ROUTER_ROUTES_PATH = "/policy/routes.json";
		expect(
			routerAliasEnabled(),
			"a configured routes file used to BE the on switch, so the alias took models[0] the moment " +
				"the policy existed"
		).toBe(false);
	});

	it("is on with the policy present and the flag on", () => {
		h.env.LLM_ROUTER_ROUTES_PATH = "/policy/routes.json";
		h.answers.set(ROUTER_ALIAS_FLAG, true);
		expect(routerAliasEnabled()).toBe(true);
	});

	it("withholds the alias LOUDLY when the flag is on but no routes path is set", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		h.answers.set(ROUTER_ALIAS_FLAG, true);

		expect(routerAliasEnabled()).toBe(false);
		expect(
			warn,
			"a flagged-on feature with no config to run on is a misconfiguration, and saying nothing " +
				"makes it indistinguishable from the flag being off"
		).toHaveBeenCalledOnce();
		expect(String(warn.mock.calls[0]?.[0])).toContain("LLM_ROUTER_ROUTES_PATH");
	});

	it("says nothing when the flag is simply off — a silent off is the correct off", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
		expect(routerAliasEnabled()).toBe(false);
		expect(warn).not.toHaveBeenCalled();
	});
});

/**
 * A registry built from fallback gates must not keep them (CUR-4194).
 *
 * A cold instance whose boot flag poll runs past REGISTRY_POLL_CAP_MS builds its registry from each
 * gate's fallback. Two things must then bring the real gates in: the first gate check compares against
 * what the registry was BUILT with (not a null that only records), and the late poll itself triggers
 * that check, since previews get no warm cron. Harness idioms follow models.boot.spec.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const BASE = "https://api.test/v1";
const MODEL_ID = "test-org/model-a";

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string>,
	snap: { current: {} as unknown },
	gates: { picker: false, routerAlias: false, agent: false, sideCallLane: false } as Record<
		string,
		unknown
	>,
	landed: [] as Array<() => unknown>,
}));

vi.mock("$lib/chat/server/config", () => {
	const config = new Proxy(H.cfg, {
		get: (target, prop) => (prop in target ? Reflect.get(target, prop) : ""),
	});
	return { config, ready: Promise.resolve() };
});
vi.mock("$app/environment", () => ({ building: true, dev: false, browser: false, version: "test" }));
vi.mock("$lib/chat/server/data/models-snapshot.json", () => ({
	get default() {
		return H.snap.current;
	},
}));
vi.mock("$lib/chat/server/modelGates", async (orig) => {
	const real = await orig<typeof import("./modelGates")>();
	return {
		...real,
		resolveRegistryGates: vi.fn(async () => ({ ...H.gates })),
		onRegistryPollLanded: vi.fn((fn: () => unknown) => {
			H.landed.push(fn);
		}),
	};
});

beforeEach(() => {
	vi.resetModules();
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, { OPENAI_BASE_URL: BASE, OPENAI_API_KEY: "test-key", MODEL_ALLOWLIST: "*" });
	H.snap.current = { fetchedAt: "2026-10-18T00:00:00.000Z", baseURL: BASE, entries: [{ id: MODEL_ID }] };
	H.gates.picker = false;
	H.landed.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ data: [{ id: MODEL_ID }] }),
		}))
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("a registry built from fallback gates is rebuilt once the real gates arrive (CUR-4194)", () => {
	it("the first gate check after boot rebuilds when a gate differs from what the registry was built with", async () => {
		const mod = await import("./models");
		await mod.bootModels(); // built with picker: false (the fallback a capped poll leaves)
		H.gates.picker = true; // the poll lands: PostHog has the picker on
		const r = await mod.refreshRegistryGatesIfChanged();
		expect(r.changed, "the first check only recorded the gates, so the fallback registry stays").toBe(true);
	});

	it("registers a late-poll hook that runs that same check, so an instance with no warm cron heals", async () => {
		const mod = await import("./models");
		await mod.bootModels();
		expect(H.landed).toHaveLength(1);
		H.gates.picker = true;
		await H.landed[0]();
		// The hook calls the module's own binding, which a spy on the export can't see, so assert the
		// effect: the hook already rebuilt, and a second check finds nothing left to change.
		const after = await mod.refreshRegistryGatesIfChanged();
		expect(after.changed).toBe(false);
		expect(after.gates.picker).toBe(true);
	});
});

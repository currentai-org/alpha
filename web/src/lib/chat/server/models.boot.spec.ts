/**
 * bootModels — the model-catalog boot loader. It must prefer a valid, base-matched
 * committed snapshot (build the registry from it with NO upstream round-trip in the foreground, then fire
 * a background live refresh) and fall back to the live catalog fetch for an absent/empty snapshot or
 * one whose baseURL doesn't match the configured primary.
 *
 * Idioms (mirrors warm.spec.ts + models.publish.spec.ts):
 *  - `config` is a Proxy over a MUTABLE object so the base URL / allowlist are fixed once here; the
 *    committed models-snapshot.json import is mocked through a getter over a MUTABLE holder so each test
 *    varies the snapshot. `$app/environment` is mocked with `building: true` so the module-eval boot at the
 *    bottom of models.ts is SKIPPED — we then drive the EXPORTED bootModels() explicitly, per scenario,
 *    which is why the spec needs `bootModels` exported (the sole non-test change to models.ts).
 *  - `vi.resetModules()` re-evaluates models.ts fresh per test (module-scope consts, empty registry).
 *  - global `fetch` is stubbed; the snapshot path uses a NEVER-resolving fetch to prove the foreground
 *    boot does not depend on it (bootModels() still resolves), and that the only fetch issued is the
 *    fire-and-forget background refresh — issued AFTER the snapshot registry was already published.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const BASE = "https://api.test/v1";
const MODEL_ID = "test-org/model-a";

const H = vi.hoisted(() => ({
	cfg: {} as Record<string, string>,
	snap: { current: {} as unknown },
	logs: { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] },
}));

// "" for unset keys (matches the real config proxy), our values for set ones. Wraps the MUTABLE cfg by
// reference so beforeEach's reseed is observed.
vi.mock("$lib/chat/server/config", () => {
	const config = new Proxy(H.cfg, {
		get: (target, prop) => (prop in target ? Reflect.get(target, prop) : ""),
	});
	return { config, ready: Promise.resolve() };
});

// Skip models.ts's module-eval boot (`if (!building) await bootModels()`) so we drive bootModels() by hand.
vi.mock("$app/environment", () => ({ building: true, dev: false, browser: false, version: "test" }));

// The committed boot snapshot import — read through a getter so each test sets H.snap.current before import.
vi.mock("$lib/chat/server/data/models-snapshot.json", () => ({
	get default() {
		return H.snap.current;
	},
}));

// Capture logs so we can distinguish the snapshot-boot path ("Booted from the committed snapshot") from
// the live path ("Model cache built").
vi.mock("$lib/chat/server/logger", () => {
	const push =
		(k: "info" | "warn" | "error") =>
		(...args: unknown[]) => {
			H.logs[k].push(args);
		};
	const logger: Record<string, unknown> = {
		info: push("info"),
		warn: push("warn"),
		error: push("error"),
		debug: () => {},
		trace: () => {},
		fatal: () => {},
		silent: () => {},
	};
	logger.child = () => logger;
	return { logger };
});

// A fake upstream /models response the live path validates + shapes.
const catalogResponse = (ids: string[]) => ({
	ok: true,
	status: 200,
	statusText: "OK",
	json: async () => ({ data: ids.map((id) => ({ id })) }),
});

const infoIncludes = (needle: string) => H.logs.info.some((a) => String(a[1]).includes(needle));

beforeEach(() => {
	vi.resetModules(); // re-evaluate models.ts (module-scope consts + empty registry) per scenario
	for (const k of Object.keys(H.cfg)) delete H.cfg[k];
	Object.assign(H.cfg, {
		OPENAI_BASE_URL: BASE,
		OPENAI_API_KEY: "test-key",
		MODEL_ALLOWLIST: "*", // expose the full catalog so any id survives the allowlist
	});
	H.logs.info.length = 0;
	H.logs.warn.length = 0;
	H.logs.error.length = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("bootModels — snapshot boot vs live fallback (§C)", () => {
	// The 120s ceiling is deliberate and must NOT be tightened back to the 30_000 default in
	// vite.config.ts. Here the timeout IS the assertion: the stubbed fetch below never settles, so a
	// foreground await on it is detectable only by waiting and observing that nothing returns. The
	// asymmetry is what makes a generous ceiling safe — correct code resolves from the snapshot in
	// milliseconds and never approaches it, while broken code hangs forever and still fails, just
	// later. So host load can only produce a false RED here, never a false green. That is the opposite
	// of warm.spec.ts, where the wall-clock was incidental and the fix was to remove it via the
	// WARM_THROTTLE_MS seam; do not reach for a seam here. A 30s default can trip on a loaded box
	// with correct code.
	it("valid snapshot → builds from it with NO upstream fetch, then fires a background refresh", { timeout: 120_000 }, async () => {
		H.snap.current = {
			fetchedAt: "2026-07-07T00:00:00.000Z",
			baseURL: BASE,
			entries: [{ id: MODEL_ID }],
		};

		// A NEVER-resolving fetch: if the foreground boot depended on an upstream fetch, bootModels() would
		// hang here. The spy also records whether the snapshot registry was ALREADY published (its boot log
		// emitted) at the instant the (background) fetch is first issued — proving no fetch preceded the build.
		let bootLoggedBeforeFetch: boolean | undefined;
		const fetchSpy = vi.fn(() => {
			bootLoggedBeforeFetch = infoIncludes("Booted from the committed snapshot");
			return new Promise<never>(() => {}); // pending — the background refresh is fire-and-forget
		});
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await mod.bootModels(); // resolves via the snapshot even though the fetch never settles

		// registry built from the snapshot entries
		expect(mod.models.map((m) => m.id)).toEqual([MODEL_ID]);
		expect(infoIncludes("Booted from the committed snapshot")).toBe(true);
		// the background refresh fired exactly one upstream fetch...
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		// ...but ONLY after the snapshot registry was already built — no fetch preceded the boot build.
		expect(bootLoggedBeforeFetch).toBe(true);
	});

	it("absent/empty snapshot → runs the live catalog fetch path", async () => {
		H.snap.current = { fetchedAt: "", baseURL: "", entries: [] }; // the committed empty default → null

		const fetchSpy = vi.fn(async () => catalogResponse([MODEL_ID]));
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await mod.bootModels();

		// fell through to the live path: it fetched the upstream catalog and built from it
		expect(fetchSpy).toHaveBeenCalled();
		expect(mod.models.map((m) => m.id)).toEqual([MODEL_ID]);
		// the live-path log, NOT the snapshot-boot log
		expect(infoIncludes("Model cache built")).toBe(true);
		expect(infoIncludes("Booted from the committed snapshot")).toBe(false);
	});

	it("mismatched-baseURL snapshot → falls back to the live catalog fetch path", async () => {
		// A well-formed snapshot captured for a DIFFERENT upstream than the one endpoints are shaped for.
		H.snap.current = { fetchedAt: "x", baseURL: "https://stale.example/v1", entries: [{ id: MODEL_ID }] };

		const fetchSpy = vi.fn(async () => catalogResponse([MODEL_ID]));
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await mod.bootModels();

		// the snapshot was rejected on the base mismatch → the live fetch ran instead
		expect(fetchSpy).toHaveBeenCalled();
		expect(mod.models.map((m) => m.id)).toEqual([MODEL_ID]);
		expect(infoIncludes("Booted from the committed snapshot")).toBe(false);
	});
});

// CUR-1249. The backup lane is a backup for a completion; it is a backup for the MODEL LIST only when
// its catalogue can satisfy the allowlist. The HF router spells Apertus `swiss-ai/Apertus-v1.5-70B`
// where the allowlist names `swiss-ai/apertus-v1.5-70b`, so a primary 404 must not swap a
// working catalogue for one that matches nothing (CUR-1246).
describe("loadCatalog — the backup lane has to satisfy the allowlist (CUR-1249)", () => {
	const BACKUP = "https://backup.test/v1";
	const PRIMARY_ID = "swiss-ai/apertus-v1.5-70b";
	const status = (code: number, headers: Record<string, string> = {}) => ({
		ok: false,
		status: code,
		statusText: String(code),
		headers: new Headers(headers),
		json: async () => ({}),
	});
	const errorIncludes = (needle: string) => H.logs.error.some((a) => String(a[1]).includes(needle));

	beforeEach(() => {
		H.snap.current = { fetchedAt: "", baseURL: "", entries: [] }; // no snapshot → the live path
		Object.assign(H.cfg, { HF_BASE_URL: BACKUP, HF_TOKEN: "hf-key", MODEL_ALLOWLIST: PRIMARY_ID });
	});

	it("refuses a backup catalogue whose ids the allowlist cannot match, instead of loading it", async () => {
		const fetchSpy = vi.fn(async (url: string) =>
			url.startsWith(BACKUP) ? catalogResponse(["swiss-ai/Apertus-v1.5-70B"]) : status(404)
		);
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await expect(mod.bootModels()).rejects.toThrow();

		expect(fetchSpy.mock.calls.map((c) => String(c[0]).startsWith(BACKUP))).toContain(true);
		expect(errorIncludes("Backup catalog cannot satisfy the allowlist")).toBe(true);
		expect(H.logs.warn.some((a) => String(a[1]).includes("loaded from BACKUP lane"))).toBe(false);
		expect(mod.registryCanServe()).toBe(false);
	});

	it("does not fail over from a primary that answers 'switched off by its flag' — that is configuration", async () => {
		const fetchSpy = vi.fn(async () => status(503, { "x-folkways-disabled": "folkways-adapter" }));
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await expect(mod.bootModels()).rejects.toThrow();

		// One call: no retry of an answer a retry cannot change, and no backup fetch.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(errorIncludes("switched off by its flag")).toBe(true);
	});

	it("still fails over when the primary is down and the backup lists the allowlisted id", async () => {
		const fetchSpy = vi.fn(async (url: string) =>
			url.startsWith(BACKUP) ? catalogResponse([PRIMARY_ID]) : status(502)
		);
		vi.stubGlobal("fetch", fetchSpy);

		const mod = await import("./models");
		await mod.bootModels();

		expect(mod.models.map((m) => m.id)).toContain(PRIMARY_ID);
		expect(mod.registryCanServe()).toBe(true);
		expect(H.logs.warn.some((a) => String(a[1]).includes("loaded from BACKUP lane"))).toBe(true);
	});
});

describe("bootModels with a misconfigured TASK_MODEL (CUR-2319)", () => {
	it("fails boot, leaving nothing servable, when TASK_MODEL names no registered model", async () => {
		H.cfg.TASK_MODEL = "nobody/no-such-model";
		H.snap.current = { fetchedAt: "", baseURL: "", entries: [] };
		vi.stubGlobal("fetch", vi.fn(async () => catalogResponse([MODEL_ID])));

		const mod = await import("./models");
		await expect(mod.bootModels()).rejects.toThrow(/TASK_MODEL/);
		expect(mod.registryCanServe()).toBe(false);
	});
});

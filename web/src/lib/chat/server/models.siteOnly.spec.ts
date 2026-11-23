/**
 * A site-only build (www) carries no inference settings. Loading models.ts there, as a scheduled job
 * registered for both projects does, must not boot the catalog: each boot logged three errors, enough
 * on its own to trip the production server-error alert. The `site` case is the control: the same
 * empty settings do log the boot failure there, so the site-only case cannot pass by never booting
 * anywhere.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
	surface: { current: "site" as string },
	errors: [] as unknown[][],
}));

vi.mock("$app/env", () => ({ building: false, dev: false, browser: false, version: "test" }));

vi.mock("$lib/surface", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/surface")>();
	return {
		...real,
		get APP_SURFACE() {
			return H.surface.current;
		},
	};
});

// Every key reads as unset, as on www's production deployment.
vi.mock("$lib/chat/server/config", () => ({
	config: new Proxy({}, { get: () => "" }),
	ready: Promise.resolve(),
}));

vi.mock("$lib/chat/server/errorTracking", () => ({ captureServerException: () => {} }));

vi.mock("$lib/chat/server/logger", () => {
	const noop = () => {};
	const logger: Record<string, unknown> = {
		info: noop,
		warn: noop,
		debug: noop,
		trace: noop,
		fatal: noop,
		silent: noop,
		error: (...args: unknown[]) => {
			H.errors.push(args);
		},
	};
	logger.child = () => logger;
	return { logger };
});

const previousHermetic = process.env.CI_HERMETIC;

beforeEach(() => {
	vi.resetModules();
	H.errors.length = 0;
	process.env.CI_HERMETIC = "false";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("no network in this spec");
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (previousHermetic === undefined) delete process.env.CI_HERMETIC;
	else process.env.CI_HERMETIC = previousHermetic;
});

describe("models.ts module load without inference settings", () => {
	it("a site-only build loads the module without booting the catalog or logging an error", async () => {
		H.surface.current = "site-only";
		await import("./models");
		expect(H.errors).toEqual([]);
	});

	it("a site build with the same settings does try to boot, and logs the failure", async () => {
		H.surface.current = "site";
		await import("./models");
		expect(H.errors.some((a) => String(a[1] ?? a[0]).includes("Startup model init failed"))).toBe(true);
	});
});

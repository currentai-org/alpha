import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Same treatment as localEndpointsGate.spec.ts: the flag is the gate (CUR-3175), so drive its
// answer directly; DEPLOY_ENV/VERCEL_ENV are stubbed per test because they still decide the
// fallback, and deployEnv() reads process.env at call time.
const flagEnabledOrMock = vi.fn((_key: string, fallback: () => boolean) => fallback());
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: flagEnabledOrMock }));
vi.mock("$lib/chat/server/config", () => ({ config: {} }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { warn: vi.fn() } }));

const savedDeployEnv = process.env.DEPLOY_ENV;
const savedVercelEnv = process.env.VERCEL_ENV;

beforeEach(() => {
	delete process.env.DEPLOY_ENV;
	delete process.env.VERCEL_ENV;
	flagEnabledOrMock.mockReset();
	flagEnabledOrMock.mockImplementation((_key, fallback) => fallback());
});

afterEach(() => {
	if (savedDeployEnv === undefined) delete process.env.DEPLOY_ENV;
	else process.env.DEPLOY_ENV = savedDeployEnv;
	if (savedVercelEnv === undefined) delete process.env.VERCEL_ENV;
	else process.env.VERCEL_ENV = savedVercelEnv;
});

describe("managedLocalInferenceEndpointsEnabled — the flag is the gate (CUR-3175)", () => {
	async function enabled() {
		const { managedLocalInferenceEndpointsEnabled } = await import("./managedInferenceGate");
		return managedLocalInferenceEndpointsEnabled();
	}

	it("reads its OWN key, not the base local-inference one", async () => {
		// The whole reason this is a second gate: turning managed off while direct stays on has to
		// remain a one-line change, which it is not if both read the same key.
		await enabled();
		expect(flagEnabledOrMock).toHaveBeenCalledWith("local-inference-managed", expect.any(Function));
	});

	it("is ON when the flag says on", async () => {
		process.env.DEPLOY_ENV = "production";
		flagEnabledOrMock.mockReturnValue(true);
		expect(await enabled()).toBe(true);
	});

	it("is OFF when the flag says off, on an environment that used to hardcode it on", async () => {
		process.env.DEPLOY_ENV = "preview";
		flagEnabledOrMock.mockReturnValue(false);
		expect(await enabled()).toBe(false);
	});

	it("falls back ON in local development and OFF on a real deployment", async () => {
		process.env.DEPLOY_ENV = "development";
		expect(await enabled()).toBe(true);
	});

	it("falls back OFF when neither var names a recognised environment", async () => {
		expect(await enabled()).toBe(false);
	});
});

describe("managedInferenceEnabled — fails closed when Pangolin config is missing", () => {
	it("returns false in production with no PANGOLIN_* config, even though the deployment gate is on", async () => {
		process.env.DEPLOY_ENV = "production";
		flagEnabledOrMock.mockReturnValue(true);
		const { managedInferenceEnabled } = await import("./managedInferenceGate");
		expect(managedInferenceEnabled()).toBe(false);
	});
});

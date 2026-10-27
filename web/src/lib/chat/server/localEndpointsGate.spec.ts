import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The FLAG is the gate now (CUR-3175), so drive its answer directly — flags.spec.ts covers the
// polling plane itself. Same shape as dictationMode.spec.ts, whose gate made this move first.
const flagEnabledOrMock = vi.fn((_key: string, fallback: () => boolean) => fallback());
vi.mock("$lib/chat/server/flags", () => ({ flagEnabledOr: flagEnabledOrMock }));

// DEPLOY_ENV/VERCEL_ENV still matter, but only for the fallback: deployEnv() reads process.env at
// call time, so each test stubs them and imports fresh.
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

async function enabled() {
	const { localInferenceEndpointsEnabled } = await import("./localEndpointsGate");
	return localInferenceEndpointsEnabled();
}

describe("localInferenceEndpointsEnabled — the flag is the gate (CUR-3175)", () => {
	it("reads the local-inference key, not some other flag", async () => {
		await enabled();
		expect(flagEnabledOrMock).toHaveBeenCalledWith("local-inference", expect.any(Function));
	});

	it("is ON when the flag says on, whatever the environment", async () => {
		// The point of the move: rolling this out stops being a redeploy. Production is named here
		// because it is the case the old env check could not express without a code change.
		process.env.DEPLOY_ENV = "production";
		flagEnabledOrMock.mockReturnValue(true);
		expect(await enabled()).toBe(true);
	});

	it("is OFF when the flag says off, even on an environment that used to hardcode it on", async () => {
		// The direction that matters: a flag that cannot turn preview off would be a rollout control in
		// name only (CUR-3175).
		process.env.DEPLOY_ENV = "preview";
		flagEnabledOrMock.mockReturnValue(false);
		expect(await enabled()).toBe(false);
	});

	describe("the fallback, for when PostHog has not answered", () => {
		it("is ON in local development", async () => {
			// Deliberately not `() => false` like its siblings: a laptop that cannot reach PostHog
			// should still be able to exercise the feature. `DEPLOY_ENV=development` must not silently take
			// local inference away.
			process.env.DEPLOY_ENV = "development";
			expect(await enabled()).toBe(true);
		});

		it("is OFF on a real deployment, which must not light up just because PostHog went quiet", async () => {
			process.env.DEPLOY_ENV = "production";
			expect(await enabled()).toBe(false);
		});

		it("is OFF when neither var names a recognised environment", async () => {
			expect(await enabled()).toBe(false);
		});

		it("reads VERCEL_ENV when DEPLOY_ENV is unset, same as deployEnv() always has", async () => {
			process.env.VERCEL_ENV = "development";
			expect(await enabled()).toBe(true);
		});
	});
});

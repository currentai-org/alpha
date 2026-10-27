import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted, because vi.mock is lifted above the imports and a plain top-level const is still in
// its temporal dead zone when the factory runs.
const { warnMock } = vi.hoisted(() => ({ warnMock: vi.fn() }));
vi.mock("$lib/chat/server/logger", () => ({ logger: { info: vi.fn(), warn: warnMock } }));

import { deployEnv, __resetDeployEnvWarnings } from "$lib/chat/server/deployEnv";
import { deployedEnv } from "../../../../config/inference";

const saved = { DEPLOY_ENV: process.env.DEPLOY_ENV, VERCEL_ENV: process.env.VERCEL_ENV };

function setEnv(k: "DEPLOY_ENV" | "VERCEL_ENV", v: string | undefined) {
	if (v === undefined) delete process.env[k];
	else process.env[k] = v;
}

beforeEach(() => {
	warnMock.mockClear();
	__resetDeployEnvWarnings();
	setEnv("DEPLOY_ENV", undefined);
	setEnv("VERCEL_ENV", undefined);
});

afterEach(() => {
	setEnv("DEPLOY_ENV", saved.DEPLOY_ENV);
	setEnv("VERCEL_ENV", saved.VERCEL_ENV);
});

describe("deployEnv", () => {
	it("prefers DEPLOY_ENV over the host's VERCEL_ENV, so the new host wins during the migration", () => {
		setEnv("VERCEL_ENV", "production");
		setEnv("DEPLOY_ENV", "preview");
		expect(deployEnv()).toBe("preview");
	});

	it("falls back to VERCEL_ENV while we are still on Vercel — this change is a no-op today", () => {
		setEnv("VERCEL_ENV", "production");
		expect(deployEnv()).toBe("production");
		expect(warnMock).not.toHaveBeenCalled();
	});

	// The manifest declares DEPLOY_ENV, so an unconfigured deployment can see it as "" (the
	// scaffold's blank placeholder) rather than absent. A `??` chain would stop at that "" and never
	// reach VERCEL_ENV — the same silent-dark-feature failure this module exists to catch, just from
	// a blank string instead of a typo. (CUR-142)
	it("falls back to VERCEL_ENV when DEPLOY_ENV is blank, not just when it's absent", () => {
		setEnv("DEPLOY_ENV", "");
		setEnv("VERCEL_ENV", "production");
		expect(deployEnv()).toBe("production");
		expect(warnMock).not.toHaveBeenCalled();
	});

	// THE FAILURE THIS MODULE EXISTS TO CATCH. On a host that doesn't set VERCEL_ENV, returning the literal
	// "development" would leave every flag scoped `env == production|preview` matching nothing, and every
	// gated feature dark for everyone while the deployment looked healthy.
	// Returning null is what forces each call site to decide; the warn is what makes it visible.
	it("returns null (NOT a silent 'development') and warns loudly when no environment is declared", () => {
		expect(deployEnv()).toBeNull();
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0][1]).toMatch(/neither DEPLOY_ENV nor VERCEL_ENV is set/);
		expect(warnMock.mock.calls[0][1]).toMatch(/fail closed/);
	});

	it("treats an unrecognised value as undeclared rather than passing it through to PostHog", () => {
		// A typo like `DEPLOY_ENV=prod` must not reach a flag as a live environment name: it would match
		// no condition, which is the same silent dark-feature failure with a different cause.
		setEnv("DEPLOY_ENV", "prod");
		expect(deployEnv()).toBeNull();
		expect(warnMock).toHaveBeenCalledTimes(1);
		expect(warnMock.mock.calls[0][1]).toMatch(/unrecognised deployment environment "prod"/);
	});

	it("tolerates surrounding whitespace, which is how a value arrives from a pasted env file", () => {
		setEnv("DEPLOY_ENV", "  production  ");
		expect(deployEnv()).toBe("production");
		expect(warnMock).not.toHaveBeenCalled();
	});

	it("warns once per distinct bad value, so a per-request read cannot flood the log", () => {
		deployEnv();
		deployEnv();
		deployEnv();
		expect(warnMock).toHaveBeenCalledTimes(1);

		// ...but a genuinely different misconfiguration still gets its own line.
		setEnv("DEPLOY_ENV", "staging");
		deployEnv();
		expect(warnMock).toHaveBeenCalledTimes(2);
	});

	it("accepts every value the type admits", () => {
		for (const v of ["production", "preview", "development"] as const) {
			setEnv("DEPLOY_ENV", v);
			expect(deployEnv()).toBe(v);
		}
		expect(warnMock).not.toHaveBeenCalled();
	});
});

describe("deployedEnv (config/inference.ts) agrees with deployEnv() on what counts as a deployment", () => {
	it.each([
		[undefined, undefined],
		["", "production"],
		["preview", "production"],
		["production", undefined],
		[undefined, "preview"],
		["development", "production"],
		[" preview ", undefined],
		["staging", undefined],
	])("DEPLOY_ENV=%j VERCEL_ENV=%j", (deploy, vercel) => {
		setEnv("DEPLOY_ENV", deploy);
		setEnv("VERCEL_ENV", vercel);
		const env = deployEnv();
		const deployed = env === "production" || env === "preview" ? env : null;
		expect(deployedEnv(process.env)).toBe(deployed);
	});
});

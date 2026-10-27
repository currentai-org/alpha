import { describe, it, expect } from "vitest";
import { allKeys, requiredKeys, warnKeys } from "../../../../../config/env-manifest.mjs";

describe("env-manifest.mjs — single source of truth", () => {
	it("declares the hard-required prod vars (the CI gate + boot validation enforce these)", () => {
		for (const k of [
			"OPENAI_BASE_URL",
			"OPENAI_API_KEY",
			"DATABASE_URL",
			"PUBLIC_ORIGIN",
		]) {
			expect(requiredKeys()).toContain(k);
		}
	});

	it("flags SOVEREIGN_HOSTS as soft-required — the var whose silent absence underclaimed CSCS", () => {
		expect(warnKeys()).toContain("SOVEREIGN_HOSTS");
	});

	it("every required + warn key exists in the manifest key set", () => {
		for (const k of [...requiredKeys(), ...warnKeys()]) expect(allKeys()).toContain(k);
	});
});

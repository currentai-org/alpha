import { describe, expect, it } from "vitest";
import { DEFAULT_INSTANCE, deploymentInstance, isEventInstance } from "$lib/chat/server/instance";

// INSTANCE names an event deployment (mozfest, lugano). Unset has to mean www, because
// every deployment that predates the variable has it unset. (CUR-3156)
describe("deploymentInstance", () => {
	it("reads unset and blank as www, so existing deployments are unchanged", () => {
		expect(deploymentInstance({})).toBe(DEFAULT_INSTANCE);
		expect(deploymentInstance({ INSTANCE: "  " })).toBe(DEFAULT_INSTANCE);
	});

	it("returns an event instance's name", () => {
		expect(deploymentInstance({ INSTANCE: "lugano" })).toBe("lugano");
	});

	// A malformed name falling back to www would hand the instance www's apex cookie.
	it("throws on a name that isn't a lowercase label, rather than guessing www", () => {
		for (const INSTANCE of ["MozFest", "moz fest", "moz.fest", "-mozfest"]) {
			expect(() => deploymentInstance({ INSTANCE })).toThrow(/INSTANCE/);
		}
	});
});

describe("isEventInstance", () => {
	it("is true only for a non-www instance in production", () => {
		expect(isEventInstance({ VERCEL_ENV: "production", INSTANCE: "mozfest" })).toBe(true);
		expect(isEventInstance({ VERCEL_ENV: "production" })).toBe(false);
		expect(isEventInstance({ VERCEL_ENV: "production", INSTANCE: "www" })).toBe(false);
	});

	// A preview with INSTANCE set keeps the preview cookie and RP ID; only production needed separating.
	it("is false on a preview, whatever INSTANCE says", () => {
		expect(isEventInstance({ VERCEL_ENV: "preview", INSTANCE: "mozfest" })).toBe(false);
	});
});

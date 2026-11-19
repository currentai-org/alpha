import { describe, expect, it } from "vitest";
import {
	computeOAuthProxyProductionURL,
	computePreviewTrustedOrigins,
} from "$lib/chat/server/betterAuth";
// Better Auth's own origin matcher, imported by path because the package does not export it.
// It is the function origin-check.mjs runs against trustedOrigins, so these cases test the real rule.
// A better-auth upgrade that moves the file fails the import, which is the right time to re-check.
// @ts-expect-error -- untyped dist module outside the package's exports map
import { matchesOriginPattern } from "../../../../node_modules/better-auth/dist/auth/trusted-origins.mjs";

// The OAuth proxy is registered only where it is safe and useful. Every preview (develop and
// each PR) shares one secret and database, so the proxy adds no authority there. Production must never
// register it: a production sign-in has no other deployment to hand a profile to.
const DEVELOP = "https://develop.example.test";

describe("computeOAuthProxyProductionURL", () => {
	it("points every preview deployment's proxy at PUBLIC_ORIGIN (develop)", () => {
		expect(computeOAuthProxyProductionURL("preview", DEVELOP)).toBe(DEVELOP);
	});

	it("registers no proxy on production, even with PUBLIC_ORIGIN set", () => {
		expect(computeOAuthProxyProductionURL("production", "https://www.example.test")).toBeUndefined();
	});

	it("registers no proxy in local dev or an undeclared environment", () => {
		expect(computeOAuthProxyProductionURL("development", DEVELOP)).toBeUndefined();
		expect(computeOAuthProxyProductionURL(null, DEVELOP)).toBeUndefined();
	});

	it("registers no proxy on a preview with PUBLIC_ORIGIN unset, rather than proxying to nowhere", () => {
		expect(computeOAuthProxyProductionURL("preview", undefined)).toBeUndefined();
	});
});

function trustedOnPreview(origin: string): boolean {
	const patterns = computePreviewTrustedOrigins("preview") ?? [];
	return patterns.some((p) => matchesOriginPattern(origin, p));
}

describe("computePreviewTrustedOrigins", () => {
	it("trusts this team's per-deployment preview host", () => {
		expect(trustedOnPreview("https://alpha-1bw9e9i78-example.vercel.app")).toBe(true);
	});

	it("trusts this team's per-branch preview host", () => {
		expect(
			trustedOnPreview("https://alpha-git-feature-branch-a-example.vercel.app")
		).toBe(true);
	});

	it("refuses another Vercel user's site, which *.vercel.app used to trust", () => {
		expect(trustedOnPreview("https://evil.vercel.app")).toBe(false);
		expect(trustedOnPreview("https://alpha-1bw9e9i78-someone-else.vercel.app")).toBe(false);
	});

	it("refuses a host that only contains our suffix", () => {
		expect(trustedOnPreview("https://alpha-1bw9e9i78-example.vercel.app.evil.com")).toBe(false);
		expect(trustedOnPreview("http://alpha-1bw9e9i78-example.vercel.app")).toBe(false);
	});

	it("adds no preview origins on production or in local dev", () => {
		expect(computePreviewTrustedOrigins("production")).toBeUndefined();
		expect(computePreviewTrustedOrigins("development")).toBeUndefined();
		expect(computePreviewTrustedOrigins(null)).toBeUndefined();
	});
});

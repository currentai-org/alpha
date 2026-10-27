import { describe, expect, it } from "vitest";
import { resolveApiCorsOrigin } from "./corsOrigin";

// resolveApiCorsOrigin matches against the request's own origin as well as the static PUBLIC_ORIGIN,
// because an ephemeral per-PR preview's Origin header never equals the value shared by every preview
// deployment. A same-origin API caller there must get Access-Control-Allow-Origin naming its own host,
// not a stale develop.aipotluck.org (CUR-1172).
describe("resolveApiCorsOrigin", () => {
	it("allows everything in dev", () => {
		expect(resolveApiCorsOrigin("https://anything.example", [], { dev: true })).toBe("*");
	});

	it("allows everything when there's no Origin header (SSR)", () => {
		expect(resolveApiCorsOrigin(null, ["https://develop.aipotluck.org"], { dev: false })).toBe("*");
	});

	it("allows a localhost origin regardless of the valid-origins list", () => {
		expect(resolveApiCorsOrigin("http://localhost:5173", ["https://develop.aipotluck.org"], { dev: false })).toBe(
			"*"
		);
	});

	it("echoes back an origin matching the request's own host — the ephemeral-preview case", () => {
		const ownHost = "https://aipotluck-abc123-current-ai.vercel.app";
		expect(
			resolveApiCorsOrigin(ownHost, [ownHost, "https://develop.aipotluck.org"], { dev: false })
		).toBe(ownHost);
	});

	it("echoes back an origin matching the static PUBLIC_ORIGIN config value too", () => {
		const staticOrigin = "https://develop.aipotluck.org";
		expect(
			resolveApiCorsOrigin(staticOrigin, ["https://aipotluck-abc123-current-ai.vercel.app", staticOrigin], {
				dev: false,
			})
		).toBe(staticOrigin);
	});

	it("denies (no header at all) an origin matching neither the request host nor PUBLIC_ORIGIN", () => {
		expect(
			resolveApiCorsOrigin("https://attacker.example", ["https://aipotluck.org"], { dev: false })
		).toBeUndefined();
	});
});

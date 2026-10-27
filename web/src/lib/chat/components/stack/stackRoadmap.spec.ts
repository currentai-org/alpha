import { describe, it, expect } from "vitest";
import { ROADMAP_PRODUCTS, QUERY_PATH, ACTIVATION_ROWS } from "./stackRoadmap";

// Leak guard for the sidebar data compiled from the roadmap spreadsheet export (scripts/build-roadmap.mjs).
// This runs in CI WITHOUT the CSV — it validates the committed roadmapData.generated.ts so a future generator
// change can't silently bake hidden rows or internal columns into the repo.

// The only fields allowed on a shipped product. Anything else (hours_*, notes, additional_notes, compare,
// ready_by, dependencies, display_in_provenance…) is internal and must never appear.
const ALLOWED_KEYS = new Set([
	"id",
	"name",
	"layer",
	"bucket",
	"status",
	"path",
	"desc",
	"osProduct",
	"osOptions",
	"maintainers",
	"url",
	"provenance",
	"provenanceLinks",
	"link",
	"linkLabel",
]);

describe("roadmap sidebar data (leak guard)", () => {
	// Not an exact count: display_in_provenance=yes rows are a Sheet-authoring decision (CUR-91),
	// not a structural invariant this leak guard exists to protect — a hardcoded number here just
	// relocates the same staleness problem CUR-91 fixed in the data file into a test instead.
	it("is never empty", () => {
		expect(ROADMAP_PRODUCTS.length).toBeGreaterThan(0);
	});

	it("uses slug-style product names (id is the display name)", () => {
		for (const p of ROADMAP_PRODUCTS) {
			expect(p.name, `product "${p.id}"`).toBe(p.id);
		}
	});

	it("carries no internal/forbidden columns on any product", () => {
		for (const p of ROADMAP_PRODUCTS) {
			const leaked = Object.keys(p).filter((k) => !ALLOWED_KEYS.has(k));
			expect(leaked, `product "${p.id}" leaked keys: ${leaked.join(", ")}`).toEqual([]);
		}
	});

	it("never includes a hidden product id", () => {
		const hidden = ["query-router", "desktop-app", "cli", "browser-extension", "compute-supply"];
		const ids = new Set(ROADMAP_PRODUCTS.map((p) => p.id));
		for (const h of hidden)
			expect(ids.has(h), `hidden id "${h}" leaked into the sidebar`).toBe(false);
	});

	it("only surfaces confident maintainers (no speculative '?' entries)", () => {
		for (const p of ROADMAP_PRODUCTS) {
			for (const m of p.maintainers ?? []) {
				expect(m.includes("?"), `product "${p.id}" has speculative maintainer "${m}"`).toBe(false);
			}
		}
	});

	it("has a contiguous 1..N query path with no gaps or dupes", () => {
		const paths = ROADMAP_PRODUCTS.map((p) => p.path)
			.filter((n) => n > 0)
			.sort((a, b) => a - b);
		expect(paths).toEqual(Array.from({ length: paths.length }, (_, i) => i + 1));
		expect(QUERY_PATH.length).toBe(paths.length);
	});

	it("derives one representative activation row per non-empty layer", () => {
		// Every activation row must reference a real product; layers with no shown product are dropped.
		expect(ACTIVATION_ROWS.length).toBeGreaterThan(0);
		const ids = new Set(ROADMAP_PRODUCTS.map((p) => p.id));
		for (const row of ACTIVATION_ROWS) {
			expect(ids.has(row.product.id)).toBe(true);
			expect(row.product.layer).toBe(row.layer);
		}
	});
});

import { describe, it, expect } from "vitest";
import { sourcePrior } from "./sourcePrior";

// Deterministic reference instant (Date.parse used so the recency leg is testable without Date.now()).
const NOW = Date.parse("2026-07-03T00:00:00Z");
const raw = 0.9;
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("sourcePrior — trust leg (recency off)", () => {
	it("Wikipedia / OpenAlex get a small positive trust delta", () => {
		near(sourcePrior({ engine: "Wikipedia" }, raw, { recency: false, nowMs: NOW }), raw * 0.05);
		near(sourcePrior({ engine: "OpenAlex" }, raw, { recency: false, nowMs: NOW }), raw * 0.05);
	});
	it("Firecrawl gets a small negative trust delta", () => {
		near(sourcePrior({ engine: "Firecrawl" }, raw, { recency: false, nowMs: NOW }), raw * -0.05);
	});
	it("arXiv / Wikinews / Hugging Face are trust-neutral", () => {
		for (const engine of ["arXiv", "Wikinews", "Hugging Face"] as const) {
			near(sourcePrior({ engine }, raw, { recency: false, nowMs: NOW }), 0);
		}
	});
});

describe("sourcePrior — recency leg (recency on)", () => {
	it("fresh dated source (≤1y) gets trust + recency bonus", () => {
		near(
			sourcePrior({ engine: "OpenAlex", asOf: "2026-06-01" }, raw, { recency: true, nowMs: NOW }),
			raw * (0.05 + 0.03)
		);
	});
	it("stale dated source (>5y) gets a recency penalty", () => {
		near(
			sourcePrior({ engine: "arXiv", asOf: "2018-01-01" }, raw, { recency: true, nowMs: NOW }),
			raw * (0 - 0.03)
		);
	});
	it("undated Firecrawl is penalized on a recency turn (could carry a date, doesn't)", () => {
		near(
			sourcePrior({ engine: "Firecrawl" }, raw, { recency: true, nowMs: NOW }),
			raw * (-0.05 - 0.03)
		);
	});
	it("Wikinews is NOT penalized for a missing date — it omits asOf BY DESIGN (carve-out)", () => {
		near(sourcePrior({ engine: "Wikinews" }, raw, { recency: true, nowMs: NOW }), 0);
	});
});

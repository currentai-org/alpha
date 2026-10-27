import { describe, it, expect } from "vitest";
import {
	formatProductAttribution,
	productAttributionForNode,
	productAttributionForSlug,
} from "./provenanceProductLine";

describe("formatProductAttribution", () => {
	it("formats os_product and maintainer", () => {
		expect(
			formatProductAttribution({ os_product: "Apertus", maintainers: ["Swiss AI"] })
		).toBe("Apertus by Swiss AI");
	});

	it("returns os_product alone when no maintainer", () => {
		expect(formatProductAttribution({ os_product: "LiteLLM", maintainers: [] })).toBe("LiteLLM");
	});

	it("returns undefined when os_product is missing", () => {
		expect(formatProductAttribution({ os_product: null, maintainers: ["Someone"] })).toBeUndefined();
	});
});

describe("productAttributionForSlug", () => {
	it("resolves a known provenance product", () => {
		expect(productAttributionForSlug("web-search")).toContain("Firecrawl");
	});

	it("returns undefined for unknown slug", () => {
		expect(productAttributionForSlug("not-a-product")).toBeUndefined();
	});
});

describe("productAttributionForNode", () => {
	it("maps stack node ids to roadmap products", () => {
		expect(productAttributionForNode("apertus")).toBe(
			"Apertus by Swiss National AI Institute"
		);
		expect(productAttributionForNode("websearch")).toBe("Firecrawl");
	});
});

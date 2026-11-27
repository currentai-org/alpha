import { describe, expect, it } from "vitest";
import { catalogByGatewayId } from "$lib/chat/routing/catalog";
import { panelModelReadsImages } from "./panelImages";

describe("panelModelReadsImages", () => {
	it("takes a catalogued model's readsImages as the catalog records it, so the panel's SEA-LION v4.8 is text-only", () => {
		expect(catalogByGatewayId("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")?.readsImages).toBe(false);
		expect(panelModelReadsImages("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")).toBe(false);
	});

	it("reads images for the uncatalogued panel models the HF router lists with image input", () => {
		expect(panelModelReadsImages("google/gemma-4-31B-it")).toBe(true);
		expect(panelModelReadsImages("Qwen/Qwen3.6-35B-A3B")).toBe(true);
	});

	it("treats a model known to neither the catalog nor the list as text-only (fails closed)", () => {
		expect(panelModelReadsImages("someone/unknown-model")).toBe(false);
	});

	it("covers panel models the catalog doesn't list; a catalogued one is decided by the catalog alone", () => {
		expect(catalogByGatewayId("google/gemma-4-31B-it")).toBeUndefined();
		expect(catalogByGatewayId("Qwen/Qwen3.6-35B-A3B")).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { catalogByGatewayId } from "$lib/chat/routing/catalog";
import { panelModelReadsImages } from "./panelImages";

describe("panelModelReadsImages (CUR-4670)", () => {
	it("takes a catalogued model's readsImages as the catalog records it, so GLM-5.2 is text-only", () => {
		expect(catalogByGatewayId("zai-org/GLM-5.2")?.readsImages).toBe(false);
		expect(panelModelReadsImages("zai-org/GLM-5.2")).toBe(false);
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

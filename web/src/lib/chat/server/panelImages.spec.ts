import { describe, expect, it } from "vitest";
import { catalogByGatewayId } from "$lib/chat/routing/catalog";
import { panelModelReadsImages } from "./panelImages";

describe("panelModelReadsImages", () => {
	it("takes a catalogued model's readsImages as the catalog records it, so the panel's SEA-LION v4.8 is text-only", () => {
		expect(catalogByGatewayId("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")?.readsImages).toBe(false);
		expect(panelModelReadsImages("aisingapore/Nemotron-SEA-LION-v4.8-120B-A12B")).toBe(false);
	});

	it("treats a model the catalog doesn't list as text-only (fails closed), the router's former panelists included", () => {
		expect(panelModelReadsImages("google/gemma-4-31B-it")).toBe(false);
		expect(panelModelReadsImages("Qwen/Qwen3.6-35B-A3B")).toBe(false);
		expect(panelModelReadsImages("someone/unknown-model")).toBe(false);
	});
});

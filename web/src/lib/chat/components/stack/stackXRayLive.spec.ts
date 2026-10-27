import { describe, it, expect } from "vitest";
import { stackNodeToProductId, stackNodesToProductIds } from "./stackXRayLive";

describe("stackXRayLive", () => {
	it("maps live-stack node ids to roadmap product slugs", () => {
		expect(stackNodeToProductId("apertus")).toBe("foundation-model");
		expect(stackNodeToProductId("websearch")).toBe("web-search");
		expect(stackNodeToProductId("hermes")).toBe("agent-service");
		expect(stackNodeToProductId("safety")).toBe("trust-and-safety");
	});

	it("dedupes mapped product ids", () => {
		expect(stackNodesToProductIds(["syft-rag", "syft-epfl"])).toEqual(["federated-rag"]);
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const lane = vi.hoisted(() => ({
	value: null as null | { baseURL: string; apiKey: string; wireId: string },
}));

vi.mock("./modelsCatalog", () => ({ mistralLaneFor: () => lane.value }));

import { modelUnderTestEndpoint } from "./modelUnderTestEndpoint";

const FALLBACK = { baseURL: "https://gateway.example/v1/", apiKey: "gw-key" };

describe("modelUnderTestEndpoint", () => {
	beforeEach(() => {
		lane.value = null;
	});

	it("sends a model chat's Mistral lane serves there, under the router's own id, as a real turn goes", () => {
		lane.value = { baseURL: "https://router.example/v1/", apiKey: "router-key", wireId: "mistralai/mistral-medium-3-5" };
		expect(modelUnderTestEndpoint("mistral-medium-2604", FALLBACK)).toEqual({
			baseURL: "https://router.example/v1",
			apiKey: "router-key",
			wireModel: "mistralai/mistral-medium-3-5",
			lane: "mistral",
		});
	});

	it("sends any other model to the OpenAI-compatible endpoint the spec names, under our id", () => {
		expect(modelUnderTestEndpoint("zai-org/GLM-5.3", FALLBACK)).toEqual({
			baseURL: "https://gateway.example/v1",
			apiKey: "gw-key",
			wireModel: "zai-org/GLM-5.3",
			lane: "openai",
		});
	});
});

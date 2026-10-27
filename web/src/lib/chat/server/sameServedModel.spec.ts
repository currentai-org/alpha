import { describe, expect, it } from "vitest";
import { sameServedModel } from "../../../../config/picker";

// A served-model check must accept another host's name for the same weights and still fail a
// different model, or it either pages on a deliberate second host or goes blind to a substitution. (CUR-4343)
describe("sameServedModel", () => {
	it("reads Scaleway's mistral-medium-3.5-128b as the mistral-medium-2604 that was asked for", () => {
		expect(sameServedModel("mistral-medium-2604", "mistral-medium-3.5-128b")).toBe(true);
	});

	it("matches an id to itself across a :provider pin and case", () => {
		expect(sameServedModel("mistral-medium-2604:mistral", "Mistral-Medium-2604")).toBe(true);
	});

	it("fails a different model, including one a backup lane serves", () => {
		expect(sameServedModel("mistral-medium-2604", "zai-org/GLM-5.2")).toBe(false);
		expect(sameServedModel("mistral-medium-2604", "mistral-large-2512")).toBe(false);
	});

	it("does not read an alias backwards onto a model that never listed it", () => {
		expect(sameServedModel("mistral-large-2512", "mistral-medium-3.5-128b")).toBe(false);
	});
});

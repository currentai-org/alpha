// Large 4 ignores a tool_choice naming one tool, so a forced web_search round sent that way comes back
// as text that loops until cut. A model marked `namedToolChoice: false` in the catalog is sent "required".
import { describe, it, expect } from "vitest";
import { wireToolChoice } from "./calculateTool";

const named = { type: "function" as const, function: { name: "web_search" } };

describe("wireToolChoice", () => {
	it("sends Large 4 a named tool choice as \"required\", under the id the lane asks for and the router's", () => {
		expect(wireToolChoice(named, "mistral-large-2610")).toBe("required");
		expect(wireToolChoice(named, "mistralai/mistral-large-2610")).toBe("required");
	});

	it("keeps the named choice for a model that honours it", () => {
		expect(wireToolChoice(named, "mistral-medium-2604")).toEqual(named);
	});

	it("leaves auto and none alone on Large 4, so the closing round still offers no tool", () => {
		expect(wireToolChoice("auto", "mistral-large-2610")).toBe("auto");
		expect(wireToolChoice("none", "mistral-large-2610")).toBe("none");
	});

	it("keeps the named choice for an id the catalog does not know", () => {
		expect(wireToolChoice(named, "someone/unknown-model")).toEqual(named);
		expect(wireToolChoice(named, undefined)).toEqual(named);
	});
});

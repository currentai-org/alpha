import { describe, expect, it } from "vitest";
import type { Model } from "$lib/chat/types/Model";
import { findCurrentModel, servedPick } from "./models";

const ALIA = "BSC-LT/ALIA-40b-instruct";
const DEFAULT = "mistral-medium-2604";
const model = (id: string) => ({ id }) as Model;

// A link to /chat/models/<ALIA> opened while the registry briefly lacked ALIA showed the list's first
// model and sent the turn to it, so a hand-picked ALIA turn was answered by Mistral.
describe("servedPick", () => {
	it("sends to the picked model while the registry lists it", () => {
		expect(servedPick([model(DEFAULT), model(ALIA)], ALIA)).toBe(ALIA);
	});

	it("never sends a picked model's turn to the first listed model when the registry lacks the pick", () => {
		const registry = [model(DEFAULT), model("swiss-ai/apertus-v1.5-70b")];
		// What the page shows in the pick's place, and the model the turn used to go to.
		expect(findCurrentModel(registry, ALIA)?.id).toBe(DEFAULT);
		expect(servedPick(registry, ALIA)).toBeUndefined();
	});

	it("sends nothing from an empty registry", () => {
		expect(servedPick([], ALIA)).toBeUndefined();
	});
});

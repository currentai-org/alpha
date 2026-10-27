import { describe, it, expect } from "vitest";
import { resolveConversationModel } from "./conversationModel";

// The names here state the CONTRACT rather than the observed behaviour, because this module widens on
// purpose: "returns a model" is true of every branch and would keep passing if the widening silently
// swallowed a picked id too. What each test guarantees is in its title.

const REGISTRY = [
	{ id: "swiss-ai/apertus-v1.5-70b" },
	{ id: "potluck-agent" },
] as const satisfies readonly { id: string }[];
const DEFAULT = REGISTRY[0];

describe("resolveConversationModel", () => {
	it("serves the conversation's own model, and reports no substitution, when the id still resolves", () => {
		const r = resolveConversationModel(REGISTRY, DEFAULT, "potluck-agent");
		expect(r.model.id).toBe("potluck-agent");
		expect(r.retiredId).toBeUndefined();
	});

	it("falls back to the default AND names the retired id, so the substitution cannot be silent", () => {
		// A conversation created on an id since collapsed onto 1.5 (CUR-243); continuing one must not 410.
		const r = resolveConversationModel(REGISTRY, DEFAULT, "swiss-ai/apertus-70b-instruct");
		expect(r.model.id).toBe("swiss-ai/apertus-v1.5-70b");
		expect(r.retiredId).toBe("swiss-ai/apertus-70b-instruct");
	});

	it("reports a retired id for a conversation with no stored model at all, rather than treating it as a hit", () => {
		// `retiredId` is what the caller logs on. An unset id resolving to the default without one would
		// be the same widening with nothing recording it.
		expect(resolveConversationModel(REGISTRY, DEFAULT, undefined).retiredId).toBe("(unset)");
		expect(resolveConversationModel(REGISTRY, DEFAULT, "").retiredId).toBe("(unset)");
	});

	it("matches the id exactly — a checkpoint that differs only in case is a DIFFERENT model, not a hit", () => {
		// The gateway serves `swiss-ai/apertus-v1.5-70b`; the public model card is
		// `swiss-ai/Apertus-v1.5-70B`. Case-folding here would resolve a card id to a wire id and call it
		// the same registration, which is how a wrong-lane serve gets reported as the right one.
		const r = resolveConversationModel(REGISTRY, DEFAULT, "swiss-ai/Apertus-v1.5-70B");
		expect(r.retiredId).toBe("swiss-ai/Apertus-v1.5-70B");
	});
});

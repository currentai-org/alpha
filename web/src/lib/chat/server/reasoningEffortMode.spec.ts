import { describe, it, expect } from "vitest";
import { resolveReasoningEffort } from "./reasoningEffortMode";

describe("resolveReasoningEffort — a stored override cannot outrank the model's own capability (CUR-700)", () => {
	it("THE HOLE THIS CLOSES: a stale/leftover override of true does not reach a non-reasoning model", () => {
		expect(
			resolveReasoningEffort({ supportsReasoning: false, override: true, effort: "high" })
		).toBeUndefined();
	});

	it("a non-reasoning model gets no reasoning_effort even with no override at all", () => {
		expect(
			resolveReasoningEffort({ supportsReasoning: false, override: undefined, effort: "high" })
		).toBeUndefined();
	});

	it("a reasoning-capable model defaults ON (no override needed) and forwards the effort", () => {
		expect(
			resolveReasoningEffort({ supportsReasoning: true, override: undefined, effort: "medium" })
		).toBe("medium");
	});

	it("a reasoning-capable model honours an explicit off override", () => {
		expect(
			resolveReasoningEffort({ supportsReasoning: true, override: false, effort: "medium" })
		).toBeUndefined();
	});

	it("a reasoning-capable model honours an explicit on override", () => {
		expect(
			resolveReasoningEffort({ supportsReasoning: true, override: true, effort: "low" })
		).toBe("low");
	});
});

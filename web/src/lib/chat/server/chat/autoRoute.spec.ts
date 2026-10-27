import { describe, expect, it } from "vitest";
import { autoRouteForTurn } from "./autoRoute";

const claim = { model: "mistral-large", reasons: [" Spanish ", ""], explanation: " A Spanish medium task. " };

describe("autoRouteForTurn (CUR-3944)", () => {
	it("keeps Auto's choice when it names the model this turn runs on, under either lane's id", () => {
		const expected = { model: "mistral-large", reasons: ["Spanish"], explanation: "A Spanish medium task." };
		expect(autoRouteForTurn(claim, "mistral-large-2512", false)).toEqual(expected);
		expect(autoRouteForTurn(claim, "mistralai/mistral-large-2512", undefined)).toEqual(expected);
	});

	it("drops a claim that names a different model than the turn runs on, so X-ray never credits Auto with another model's answer", () => {
		expect(autoRouteForTurn(claim, "swiss-ai/apertus-v1.5-70b", false)).toBeUndefined();
	});

	it("drops a claim naming no catalog model", () => {
		expect(autoRouteForTurn({ ...claim, model: "nope" }, "mistral-large-2512", false)).toBeUndefined();
	});

	it("records nothing on a retry, which Auto did not judge again, or with no claim", () => {
		expect(autoRouteForTurn(claim, "mistral-large-2512", true)).toBeUndefined();
		expect(autoRouteForTurn(undefined, "mistral-large-2512", false)).toBeUndefined();
	});

	it("keeps a retry's claim only when it is Auto's re-pick away from a different first choice (CUR-4384)", () => {
		expect(autoRouteForTurn({ ...claim, repickedFrom: "alia-40b" }, "mistral-large-2512", true)).toEqual({
			model: "mistral-large",
			reasons: ["Spanish"],
			explanation: "A Spanish medium task.",
			repickedFrom: "alia-40b",
		});
		expect(autoRouteForTurn({ ...claim, repickedFrom: "mistral-large" }, "mistral-large-2512", true)).toBeUndefined();
		expect(autoRouteForTurn({ ...claim, repickedFrom: " " }, "mistral-large-2512", true)).toBeUndefined();
	});
});

import { describe, it, expect } from "vitest";
import { parseVerdict } from "./compareVerdict";

const GOOD = `Here is the verdict: {"agreement":"high","headline":"The panel agrees.","consensus":["a"],"contradictions":[],"weakSpots":["b"]}`;

describe("parseVerdict names the step that lost a verdict, so a neutral fallback is never unexplained", () => {
	it("returns the aggregator's own verdict with outcome parsed when the JSON is valid", () => {
		const { verdict, outcome } = parseVerdict(GOOD, 3, true);
		expect(outcome).toBe("parsed");
		expect(verdict.agreement).toBe("high");
		expect(verdict.headline).toBe("The panel agrees.");
		expect(verdict.weakSpots).toEqual(["b"]);
	});

	it("falls back with outcome no_answer when the aggregator returned nothing (timeout, empty, capped)", () => {
		const { verdict, outcome } = parseVerdict(null, 3, true);
		expect(outcome).toBe("no_answer");
		expect(verdict.consensus).toEqual([]);
		expect(verdict.headline).toMatch(/Compared this answer against 3 independent open models/);
	});

	it("falls back with outcome no_json when the reply is prose with no object in it", () => {
		expect(parseVerdict("The models broadly agree.", 2, true).outcome).toBe("no_json");
	});

	it("falls back with outcome bad_json when the braces hold something that does not parse", () => {
		expect(parseVerdict('{"agreement": "high", headline: oops}', 2, true).outcome).toBe("bad_json");
	});

	it("never claims a comparison ran when there was no primary answer", () => {
		const { verdict } = parseVerdict(null, 1, false);
		expect(verdict.headline).toBe(
			"1 independent open model weighed in on this question — see their takes below."
		);
	});
});

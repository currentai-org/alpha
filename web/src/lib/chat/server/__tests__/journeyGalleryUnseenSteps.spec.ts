import { describe, expect, it } from "vitest";

import { unseenSteps, type JourneyCard } from "../journeyGallery";

/**
 * CUR-2245. The board's summary sentence names every step a passing test claims and no frame shows,
 * so a reader sees them without opening each card. What breaks this is an `inconclusive` step (the
 * doc already says nothing walks it) counted as unseen, or an unseen one on a later card dropped.
 */
type Card = Pick<JourneyCard, "journey" | "findings">;
const f = (step: number, conclusion: string) =>
	({ step, conclusion, observation: "o", rationale: "r" }) as NonNullable<JourneyCard["findings"]>[number];

describe("unseenSteps", () => {
	it("lists only unseen steps, in board order, across every card", () => {
		const cards: Card[] = [
			{ journey: "F5", findings: [f(2, "unseen"), f(3, "inconclusive"), f(4, "product")] },
			{ journey: "A1", findings: [] },
			{ journey: "F6", findings: [f(4, "unseen")] },
		];
		expect(unseenSteps(cards)).toEqual([
			{ journey: "F5", step: 2 },
			{ journey: "F6", step: 4 },
		]);
	});

	it("returns nothing for a board with no unseen step, so the sentence is not rendered", () => {
		expect(unseenSteps([{ journey: "A2", findings: [f(5, "inconclusive")] }])).toEqual([]);
	});
});

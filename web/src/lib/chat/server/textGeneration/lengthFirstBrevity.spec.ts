import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EndpointMessage } from "../endpoints/types";

// Wiring only: proves the length-first-brevity flag decides which brevity sentence reaches the user
// turn. Whether Apertus then writes the long guide is a live question, answered by
// evals/inspect_tasks/office_drafts.py with the flag forced on and off (CUR-2126).

let flagValue = false;
vi.mock("./lengthFirstBrevityGate", () => ({ lengthFirstBrevityEnabled: () => flagValue }));

const { hardenLastUserTurn } = await import("./grounding");

async function wrapped(text: string): Promise<string> {
	const messages: EndpointMessage[] = [{ from: "user", content: text }];
	await hardenLastUserTurn(messages, undefined, false);
	return messages[0].content ?? "";
}

beforeEach(() => {
	flagValue = false;
});

describe("length-first-brevity flag", () => {
	it("off, the turn keeps today's brevity sentence with its long-essay contrast", async () => {
		const turn = await wrapped("write a 1,500-word onboarding guide");
		expect(turn).toContain("Answer concisely by default");
		expect(turn).toContain("not a long essay");
	});

	it("on, the requested length comes before the concise default and the long-essay contrast is gone", async () => {
		flagValue = true;
		const turn = await wrapped("write a 1,500-word onboarding guide");
		const lengthAt = turn.indexOf("asks for a specific length or a long document");
		const conciseAt = turn.indexOf("answer concisely");
		expect(lengthAt).toBeGreaterThanOrEqual(0);
		expect(conciseAt).toBeGreaterThan(lengthAt);
		expect(turn).not.toContain("long essay");
	});
});

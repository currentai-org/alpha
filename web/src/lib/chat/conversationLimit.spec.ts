import { describe, expect, it } from "vitest";
import { conversationLimitMessage } from "./conversationLimit";

describe("conversationLimitMessage (CUR-2891)", () => {
	it("names the count, the limit, and the number to delete for an account carried past the cap", () => {
		expect(conversationLimitMessage(173, 100)).toBe(
			"You have 173 conversations and the limit is 100. Delete 74 to start a new one."
		);
	});

	it("asks for one deletion at exactly the cap, since the new chat needs a free slot", () => {
		expect(conversationLimitMessage(100, 100)).toBe(
			"You have 100 conversations and the limit is 100. Delete 1 to start a new one."
		);
	});

	it("says conversation, not conversations, for a single one", () => {
		expect(conversationLimitMessage(1, 1)).toBe(
			"You have 1 conversation and the limit is 1. Delete 1 to start a new one."
		);
	});
});

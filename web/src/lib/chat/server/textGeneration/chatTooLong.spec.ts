import { describe, expect, it } from "vitest";
import { messageTooLongMessage } from "./chatTooLong";
import { MessageTooLongError } from "../endpoints/openai/fitHistory";

describe("messageTooLongMessage", () => {
	it("tells the visitor to shorten the message, never to Retry, for a refused over-long message", () => {
		const copy = messageTooLongMessage(new MessageTooLongError(40_000, 27_904), "Apertus 70B");
		expect(copy).toBe("This message is too long for Apertus 70B to read. Shorten it, or attach less, and send it again.");
		expect(copy).not.toMatch(/retry/i);
	});

	it("returns null for any other error, so the busy, dropped and generic copy still apply", () => {
		expect(messageTooLongMessage(new Error("400 maximum context length"), "Apertus 70B")).toBeNull();
	});
});

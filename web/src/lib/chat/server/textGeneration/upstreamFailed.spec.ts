import { describe, expect, it } from "vitest";
import { upstreamFailedMessage } from "./upstreamFailed";

describe("upstreamFailedMessage (CUR-2829)", () => {
	it("names the model and Retry, and carries no status code or SDK text", () => {
		const message = upstreamFailedMessage("Mistral Large 3");
		expect(message).toBe("Mistral Large 3 couldn't answer this time. Press Retry to ask again.");
		expect(message).not.toMatch(/\d{3}/);
	});
});

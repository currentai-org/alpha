import { describe, expect, it } from "vitest";
import { upstreamBusyMessage } from "./upstreamBusy";
import { isRateLimitMessage } from "$lib/chat/stores/errors";

// The shape the openai SDK's RateLimitError carries (CUR-2307).
const sdk429 = Object.assign(new Error("429 Rate limit exceeded"), { status: 429 });

describe("upstreamBusyMessage", () => {
	it("turns a model host's 429 into busy copy that names the model and says to retry", () => {
		const copy = upstreamBusyMessage(sdk429, "Mistral Large 3");
		expect(copy).toMatch(/^Mistral Large 3 is busy right now/);
		expect(copy).toMatch(/Retry/);
		expect(copy).not.toMatch(/429|rate limit/i);
	});

	it("never reads as the visitor's own send limit, which would blame them for the provider's cap", () => {
		expect(isRateLimitMessage(upstreamBusyMessage(sdk429, "Mistral Large 3") ?? "")).toBe(false);
	});

	it("reads statusCode as well as status", () => {
		expect(upstreamBusyMessage({ statusCode: 429 }, "Apertus")).toMatch(/^Apertus is busy/);
	});

	it("returns null for any other failure, so its own message still reaches the visitor", () => {
		expect(upstreamBusyMessage(Object.assign(new Error("boom"), { status: 500 }), "X")).toBeNull();
		expect(upstreamBusyMessage(new Error("no status"), "X")).toBeNull();
		expect(upstreamBusyMessage(null, "X")).toBeNull();
	});
});

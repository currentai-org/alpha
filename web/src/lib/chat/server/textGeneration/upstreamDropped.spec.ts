import { describe, expect, it } from "vitest";
import { upstreamDroppedMessage } from "./upstreamDropped";

// The shape undici raises when a lane's socket closes mid-answer, which the `stream_truncates_midway`
// fault reproduces in generate.ts (CUR-1614).
const undiciDrop = Object.assign(new TypeError("terminated"), {
	cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
});

describe("upstreamDroppedMessage", () => {
	it("turns a stream that closed mid-answer into copy that names the model and says to retry", () => {
		const copy = upstreamDroppedMessage(undiciDrop, "Mistral Large 3");
		expect(copy).toMatch(/^The connection to Mistral Large 3 dropped/);
		expect(copy).toMatch(/Retry/);
		expect(copy).not.toMatch(/terminated|socket/i);
	});

	it("recognises a reset socket by its code, on the error or on its cause", () => {
		expect(upstreamDroppedMessage(Object.assign(new Error("read"), { code: "ECONNRESET" }), "X")).not.toBeNull();
		expect(
			upstreamDroppedMessage(new Error("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }), "X")
		).not.toBeNull();
	});

	it("returns null for any other failure, so its own message still reaches the visitor", () => {
		expect(upstreamDroppedMessage(Object.assign(new Error("429"), { status: 429 }), "X")).toBeNull();
		expect(upstreamDroppedMessage(new TypeError("Cannot read properties of undefined"), "X")).toBeNull();
		expect(upstreamDroppedMessage(null, "X")).toBeNull();
	});
});

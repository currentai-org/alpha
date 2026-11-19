import { describe, expect, it } from "vitest";
import { NoFirstChunkError } from "$lib/chat/server/endpoints/failover";
import { MessageTooLongError } from "$lib/chat/server/endpoints/openai/fitHistory";
import { failureCauseOfError } from "./failureCause";

const withStatus = (status: number) => Object.assign(new Error(`${status}`), { status });

describe("failureCauseOfError", () => {
	it("reads the 429 a saturated partner host returns as upstream-rate-limited", () => {
		expect(failureCauseOfError(withStatus(429))).toBe("upstream-rate-limited");
	});

	it("reads a 5xx (the router's 502/503 HTML pages included) as upstream-http-5xx", () => {
		expect(failureCauseOfError(withStatus(502))).toBe("upstream-http-5xx");
		expect(failureCauseOfError(Object.assign(new Error("503"), { statusCode: 503 }))).toBe("upstream-http-5xx");
	});

	it("reads a silent last lane, a dropped stream and a refused connection as the host's", () => {
		expect(failureCauseOfError(new NoFirstChunkError("no first chunk within 20000ms"))).toBe(
			"upstream-no-first-chunk"
		);
		expect(failureCauseOfError(new TypeError("terminated"))).toBe("upstream-dropped");
		expect(
			failureCauseOfError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))
		).toBe("upstream-unreachable");
		expect(failureCauseOfError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toBe(
			"upstream-unreachable"
		);
	});

	it("keeps a 400 OURS: a request the host refused as malformed is one we built (a tool-name 400)", () => {
		expect(failureCauseOfError(withStatus(400))).toBe("exception");
		expect(failureCauseOfError(withStatus(401))).toBe("exception");
	});

	it("keeps an error with no status ours: a bug in our code is not the host's", () => {
		expect(failureCauseOfError(new TypeError("Cannot read properties of undefined"))).toBe("exception");
	});

	it("reads an over-long message as the visitor's, refused before any call", () => {
		expect(failureCauseOfError(new MessageTooLongError(200_000, 128_000))).toBe("message-too-long");
	});
});

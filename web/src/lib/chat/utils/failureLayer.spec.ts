import { describe, expect, it } from "vitest";
import { classifyFailureLayer, fallbackState, type FailureLayerInputs } from "./failureLayer";

const turn = (over: Partial<FailureLayerInputs>): FailureLayerInputs => ({
	outcome: "error",
	cause: null,
	isLocalModel: false,
	firstTokenReached: false,
	...over,
});

describe("classifyFailureLayer", () => {
	it("puts a model host's 429, 5xx, silence, dropped stream and refused connection in `upstream`", () => {
		for (const cause of [
			"upstream-rate-limited",
			"upstream-http-5xx",
			"upstream-no-first-chunk",
			"upstream-dropped",
			"upstream-unreachable",
		] as const) {
			expect(classifyFailureLayer(turn({ cause }))).toBe("upstream");
		}
	});

	it("puts a watchdog stall in `upstream` only when the model call was the only thing running", () => {
		expect(classifyFailureLayer(turn({ outcome: "timedOut", cause: "watchdog-model-stalled" }))).toBe("upstream");
		expect(classifyFailureLayer(turn({ outcome: "timedOut", cause: "watchdog-our-step" }))).toBe("ours");
	});

	it("puts an exception in our code, our output screen's deadline and a guard-emptied answer in `ours`", () => {
		expect(classifyFailureLayer(turn({ cause: "exception" }))).toBe("ours");
		expect(classifyFailureLayer(turn({ outcome: "timedOut", cause: "output-screen-timeout" }))).toBe("ours");
		expect(classifyFailureLayer(turn({ outcome: "empty", firstTokenReached: true }))).toBe("ours");
	});

	it("pages on a failure nobody recorded a cause for: a null cause is `ours`, never dropped", () => {
		expect(classifyFailureLayer(turn({ cause: null }))).toBe("ours");
	});

	it("splits `no-output` on whether the host sent anything: nothing is upstream, tokens we then lost are ours", () => {
		expect(classifyFailureLayer(turn({ cause: "no-output", firstTokenReached: false }))).toBe("upstream");
		expect(classifyFailureLayer(turn({ cause: "no-output", firstTokenReached: true }))).toBe("ours");
	});

	it("puts a visitor's own local endpoint not answering, a Stop and an over-long message in `client`", () => {
		expect(classifyFailureLayer(turn({ cause: "upstream-unreachable", isLocalModel: true }))).toBe("client");
		expect(
			classifyFailureLayer(turn({ outcome: "timedOut", cause: "watchdog-model-stalled", isLocalModel: true }))
		).toBe("client");
		expect(classifyFailureLayer(turn({ outcome: "aborted" }))).toBe("client");
		expect(classifyFailureLayer(turn({ cause: "message-too-long" }))).toBe("client");
	});

	it("keeps an exception in our code `ours` on a local model too: the visitor's machine did not throw it", () => {
		expect(classifyFailureLayer(turn({ cause: "exception", isLocalModel: true }))).toBe("ours");
	});

	it("labels no layer on a turn that did not fail", () => {
		for (const outcome of ["complete", "declined", "shed"] as const) {
			expect(classifyFailureLayer(turn({ outcome, cause: "exception" }))).toBeNull();
		}
	});
});

describe("fallbackState", () => {
	it("says `tried` when a backup lane was announced, `available` for an unused backup, `none` for one lane", () => {
		expect(fallbackState({ failoverAnnounced: true, laneCount: 2 })).toBe("tried");
		expect(fallbackState({ failoverAnnounced: false, laneCount: 2 })).toBe("available");
		expect(fallbackState({ failoverAnnounced: false, laneCount: 1 })).toBe("none");
	});
});

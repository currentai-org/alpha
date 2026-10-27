import { afterEach, describe, expect, it } from "vitest";
import {
	tryAcquireGenerationSlot,
	releaseGenerationSlot,
	generationInFlight,
} from "./generationGate";

afterEach(() => {
	// Drain any slots a test left behind + reset the env knob so module state never bleeds across tests.
	while (generationInFlight() > 0) releaseGenerationSlot();
	delete process.env.MAX_CONCURRENT_GENERATIONS;
});

describe("generationGate", () => {
	it("disabled by default (env unset): admits unboundedly and tracks no slots", () => {
		delete process.env.MAX_CONCURRENT_GENERATIONS;
		for (let i = 0; i < 100; i++) expect(tryAcquireGenerationSlot()).toBe(true);
		expect(generationInFlight()).toBe(0);
	});

	it("MAX_CONCURRENT_GENERATIONS <= 0 disables the gate (fail-open)", () => {
		process.env.MAX_CONCURRENT_GENERATIONS = "0";
		expect(tryAcquireGenerationSlot()).toBe(true);
		process.env.MAX_CONCURRENT_GENERATIONS = "-5";
		expect(tryAcquireGenerationSlot()).toBe(true);
		process.env.MAX_CONCURRENT_GENERATIONS = "not-a-number";
		expect(tryAcquireGenerationSlot()).toBe(true);
		expect(generationInFlight()).toBe(0);
	});

	it("admits up to the cap, then sheds the overflow", () => {
		process.env.MAX_CONCURRENT_GENERATIONS = "2";
		expect(tryAcquireGenerationSlot()).toBe(true); // 1
		expect(tryAcquireGenerationSlot()).toBe(true); // 2
		expect(tryAcquireGenerationSlot()).toBe(false); // at capacity → shed
		expect(generationInFlight()).toBe(2);
	});

	it("releasing a slot frees capacity for the next turn", () => {
		process.env.MAX_CONCURRENT_GENERATIONS = "1";
		expect(tryAcquireGenerationSlot()).toBe(true);
		expect(tryAcquireGenerationSlot()).toBe(false);
		releaseGenerationSlot();
		expect(generationInFlight()).toBe(0);
		expect(tryAcquireGenerationSlot()).toBe(true);
	});

	it("release clamps at 0 — a double-release can never wedge the gate below zero", () => {
		process.env.MAX_CONCURRENT_GENERATIONS = "1";
		tryAcquireGenerationSlot();
		releaseGenerationSlot();
		releaseGenerationSlot(); // spurious extra release
		expect(generationInFlight()).toBe(0);
		expect(tryAcquireGenerationSlot()).toBe(true); // gate still admits, not stuck negative
	});
});

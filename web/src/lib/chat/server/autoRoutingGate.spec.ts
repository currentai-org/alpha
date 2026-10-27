import { beforeEach, describe, expect, it } from "vitest";
import { autoRoutingEnabled } from "./autoRoutingGate";
import { __resetFlagsForTest } from "./flags";

describe("Auto model routing fails closed", () => {
	beforeEach(() => __resetFlagsForTest());

	it("is off while no flag snapshot exists, so a new chat starts on the model chosen in settings", () => {
		expect(autoRoutingEnabled()).toBe(false);
	});
});

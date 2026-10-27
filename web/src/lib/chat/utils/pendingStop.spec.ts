import { describe, expect, test } from "vitest";

import { stopBeforeHandoff, takeStopOnArrival } from "./pendingStop";

/** A Stop pressed on the landing page after the conversation `id` exists. */
function stopAfterArrival(id: string) {
	const hold = stopBeforeHandoff();
	hold.reset();
	hold.arrived(id);
	hold.stop();
}

describe("pendingStop (CUR-2971)", () => {
	test("a Stop recorded on the landing page reaches that conversation's page", () => {
		stopAfterArrival("conv-a");
		expect(takeStopOnArrival("conv-a")).toBe(true);
	});

	test("applies to one turn only, so a later question in the same chat is not stopped", () => {
		stopAfterArrival("conv-b");
		takeStopOnArrival("conv-b");
		expect(takeStopOnArrival("conv-b")).toBe(false);
	});

	test("does not stop a conversation nobody pressed Stop for", () => {
		stopAfterArrival("conv-c");
		expect(takeStopOnArrival("conv-d")).toBe(false);
	});
});

describe("stopBeforeHandoff (CUR-3890)", () => {
	test("a Stop pressed before the conversation exists is recorded once it does", () => {
		const hold = stopBeforeHandoff();
		hold.reset();
		hold.stop();
		hold.arrived("conv-e");
		expect(takeStopOnArrival("conv-e")).toBe(true);
	});

	test("a Stop from an earlier send does not stop the next one", () => {
		const hold = stopBeforeHandoff();
		hold.stop();
		hold.reset();
		hold.arrived("conv-g");
		expect(takeStopOnArrival("conv-g")).toBe(false);
	});
});

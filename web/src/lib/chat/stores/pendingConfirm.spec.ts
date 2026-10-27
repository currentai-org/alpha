import { describe, expect, it } from "vitest";
import { confirmTitle } from "./pendingConfirm.svelte";

describe("pending-confirmation tab title", () => {
	// Named for the state that has to be silent. A test written only against count:1 would pass just
	// as well if every chat tab permanently announced an approval nobody had been asked for.
	it("leaves the title completely alone when nothing is waiting", () => {
		expect(confirmTitle("Baked okra recipe card", 0)).toBe("Baked okra recipe card");
		expect(confirmTitle("Baked okra recipe card", -1)).toBe("Baked okra recipe card");
	});

	it("says an approval is needed when one is", () => {
		const t = confirmTitle("Baked okra recipe card", 1);
		expect(t).toContain("Approval needed");
		expect(t).toContain("Baked okra recipe card");
	});

	it("puts the notice FIRST, because a tab strip truncates from the right", () => {
		// This is the whole point of the change — the person it is for is looking at a ~20-character
		// tab in another window. A suffix would be correct and invisible.
		expect(confirmTitle("Baked okra recipe card", 1).startsWith("Approval needed")).toBe(true);
		expect(confirmTitle("A very long conversation title that fills the tab", 2)).toMatch(
			/^Approval needed/
		);
	});

	it("carries the real number when a turn paused more than once", () => {
		expect(confirmTitle("t", 3)).toContain("(3)");
		// One is the common case and reads better without a count; two or more must show it, because
		// answering one and finding the tab still flagged is otherwise indistinguishable from a bug.
		expect(confirmTitle("t", 1)).not.toContain("(1)");
		expect(confirmTitle("t", 2)).toContain("(2)");
	});
});

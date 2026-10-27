import { describe, it, expect } from "vitest";
import { countNumbers } from "$lib/chat/types/Rungs";

describe("countNumbers", () => {
	it("counts each figure once, thousands separators and decimals included", () => {
		expect(countNumbers("3 workshops, 14 people, €18 each, 1,332 total, 0.5 FTE")).toBe(5);
		expect(countNumbers("no figures here")).toBe(0);
	});
});

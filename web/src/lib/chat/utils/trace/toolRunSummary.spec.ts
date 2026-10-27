import { describe, it, expect } from "vitest";
import { summarizeToolRun } from "./toolRunSummary";

describe("summarizeToolRun", () => {
	it("singularizes a single-count kind", () => {
		expect(summarizeToolRun({ edit: 1 })).toBe("Edited 1 file");
	});

	it("pluralizes a multi-count kind", () => {
		expect(summarizeToolRun({ execute: 2 })).toBe("Ran 2 commands");
	});

	it("renders multiple kinds in a fixed order, regardless of input key order", () => {
		expect(summarizeToolRun({ search: 1, edit: 2, execute: 1 })).toBe(
			"Edited 2 files, ran 1 command, searched 1 time"
		);
		expect(summarizeToolRun({ execute: 1, edit: 2, search: 1 })).toBe(
			"Edited 2 files, ran 1 command, searched 1 time"
		);
	});

	it("an unrecognized kind still appears in the line, generically — never silently dropped", () => {
		expect(summarizeToolRun({ some_future_kind: 3 })).toBe("Made 3 tool calls");
	});

	it("mixes a recognized kind with an unrecognized one, the unrecognized one still generic", () => {
		expect(summarizeToolRun({ edit: 1, some_future_kind: 2 })).toBe("Edited 1 file, made 2 tool calls");
	});

	it("suppresses think/switch_mode from the sentence when anything else narratable happened", () => {
		expect(summarizeToolRun({ edit: 1, think: 6 })).toBe("Edited 1 file");
		expect(summarizeToolRun({ edit: 1, switch_mode: 2 })).toBe("Edited 1 file");
	});

	it("mixes a recognized kind, an unrecognized kind, and a suppressed kind in one turn", () => {
		expect(summarizeToolRun({ edit: 1, some_future_kind: 2, think: 5 })).toBe(
			"Edited 1 file, made 2 tool calls"
		);
	});

	it("falls back to a generic clause when EVERY observed kind is suppressed — never renders a blank line for a turn that genuinely ran something", () => {
		expect(summarizeToolRun({ think: 6 })).toBe("Made 6 tool calls");
		expect(summarizeToolRun({ think: 2, switch_mode: 1 })).toBe("Made 3 tool calls");
	});

	it("returns an empty string for empty counts", () => {
		expect(summarizeToolRun({})).toBe("");
	});
});

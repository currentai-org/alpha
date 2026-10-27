import { describe, it, expect } from "vitest";
import { summarizeInterruptedAgentWork } from "./interruptedAgentSummary";

describe("summarizeInterruptedAgentWork", () => {
	it("returns undefined (not an empty-string summary) when there are no confirmations at all", () => {
		expect(summarizeInterruptedAgentWork(undefined)).toBeUndefined();
		expect(summarizeInterruptedAgentWork([])).toBeUndefined();
	});

	it("returns undefined when every confirmation is still open (no decision yet)", () => {
		expect(summarizeInterruptedAgentWork([{ title: "write a.py" }])).toBeUndefined();
	});

	it("returns undefined when nothing was ever allowed — a denied/canceled call did not complete", () => {
		expect(
			summarizeInterruptedAgentWork([
				{ title: "write a.py", decision: "deny" },
				{ title: "write b.py", decision: "canceled" },
			])
		).toBeUndefined();
	});

	it("names each allowed call, in order, when the turn stalled after some completed", () => {
		expect(
			summarizeInterruptedAgentWork([
				{ title: "Approve edit: a.py", decision: "allow" },
				{ title: "Approve edit: b.py", decision: "allow" },
				{ title: "Approve edit: c.py", decision: "allow" },
			])
		).toBe(
			'Interrupted before finishing. Steps confirmed before the stall: "Approve edit: a.py", "Approve edit: b.py", "Approve edit: c.py".'
		);
	});

	it("excludes a denied/canceled/still-open call from the list while still naming the allowed ones", () => {
		expect(
			summarizeInterruptedAgentWork([
				{ title: "Approve edit: a.py", decision: "allow" },
				{ title: "Approve delete: secrets.env", decision: "deny" },
				{ title: "Approve edit: b.py" },
			])
		).toBe('Interrupted before finishing. Steps confirmed before the stall: "Approve edit: a.py".');
	});

	// Titles are agent-service's own confirm-prompt copy — an ASK ("Approve edit: a.py"), not a
	// completed-action clause. Quoting them (rather than "Completed: <title>") sidesteps a tense this module
	// has no business assuming (CUR-1091).
	it("quotes a single title as a label rather than presuming its grammatical tense", () => {
		expect(summarizeInterruptedAgentWork([{ title: "Approve edit: a.py", decision: "allow" }])).toBe(
			'Interrupted before finishing. Steps confirmed before the stall: "Approve edit: a.py".'
		);
	});
});

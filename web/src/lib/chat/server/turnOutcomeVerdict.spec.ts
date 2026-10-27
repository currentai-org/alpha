import { describe, expect, it } from "vitest";
import { turnOutcomeVerdict, type TurnOutcomeEvidence } from "./turnOutcomeVerdict";

const QUIET_MS = 15 * 60_000; // the recovery rule's quiet period, stated here as the contract

const FAILURES = new Set(["error", "timedOut", "empty"]);
const now = new Date("2026-09-28T18:35:00Z");
const at = (iso: string) => new Date(iso);
const evidence = (over: Partial<TurnOutcomeEvidence>): TurnOutcomeEvidence => ({
	counts: {},
	failureOutcomes: FAILURES,
	newestFailureAt: null,
	completesSinceFailure: 0,
	now,
	...over,
});

// Shaped on a real burst: dozens of timeouts within 15 minutes, then two completed turns after a quiet gap.
const burst = { complete: 11, timedOut: 48 };

describe("turnOutcomeVerdict (CUR-2242)", () => {
	it("gives no verdict below the min sample, whatever the recovery evidence says", () => {
		const v = turnOutcomeVerdict(
			evidence({ counts: { complete: 3, timedOut: 2 }, newestFailureAt: at("2026-09-28T17:00:00Z"), completesSinceFailure: 3 })
		);
		expect(v.kind).toBe("no-verdict");
	});

	it("reads failing on the 6h window when the newest turns are still failing", () => {
		const v = turnOutcomeVerdict(
			evidence({ counts: burst, newestFailureAt: at("2026-09-28T18:34:00Z"), completesSinceFailure: 0 })
		);
		expect(v.kind).toBe("failing");
	});

	it("reads recovered two completed turns after a burst that ended 44 minutes ago, with the window still 81% failed", () => {
		const v = turnOutcomeVerdict(
			evidence({ counts: burst, newestFailureAt: at("2026-09-28T17:51:53Z"), completesSinceFailure: 2 })
		);
		expect(v).toMatchObject({ kind: "recovered", completesSinceFailure: 2 });
	});

	it("does not recover inside the quiet period, one millisecond short of it", () => {
		const v = turnOutcomeVerdict(
			evidence({
				counts: burst,
				newestFailureAt: new Date(now.getTime() - QUIET_MS + 1),
				completesSinceFailure: 5,
			})
		);
		expect(v.kind).toBe("failing");
	});

	it("does not recover on quiet alone — an hour of no traffic after the burst is silence, not health", () => {
		const v = turnOutcomeVerdict(
			evidence({ counts: burst, newestFailureAt: at("2026-09-28T17:30:00Z"), completesSinceFailure: 0 })
		);
		expect(v.kind).toBe("failing");
	});

	it("reads healthy under the ceiling without needing any recovery evidence", () => {
		expect(turnOutcomeVerdict(evidence({ counts: { complete: 90, error: 5 } })).kind).toBe("healthy");
	});
});

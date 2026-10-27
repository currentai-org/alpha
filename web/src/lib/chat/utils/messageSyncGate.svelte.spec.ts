import { describe, expect, test } from "vitest";
import { flushSync, untrack } from "svelte";

import { shouldSyncMessagesFromData } from "./generationState";
import { refreshUntilApplied } from "./refreshUntilApplied";

/**
 * Ordered-arrival semantics of the conversation page's data-driven resync gate.
 *
 * The page effect in `routes/chat/conversation/[id]/+page.svelte` is a line-for-line instance of
 * the replica below: `data.messages` deliveries (invalidation results) re-run an effect whose
 * decision is `shouldSyncMessagesFromData`, with `localTurnSyncHold` read TRACKED so releasing the
 * hold re-runs the effect against the then-current delivery. These tests pin the ORDERINGS that
 * cause cross-turn spillage and its races — deliveries during the
 * hold, release-after-observed-apply, and the bounded liveness residual — which a pure truth-table
 * cannot express. (A full component test of the page itself is impractical; its load/store surface
 * is the whole app. Manual verification covers the page in situ.)
 */

type Snapshot = { turn: string };

function createGateHarness() {
	let hold = $state(false);
	let reportHold = $state(false);
	let convId = $state("conv-1");
	// $state.raw: `data.messages` on the real page is a load-data PROP — a plain array identity,
	// not a deep proxy. Raw state preserves that, so the tests' identity asserts mean what the
	// page's `newMessages !== _lastSyncedMessages` comparison means.
	let dataMessages = $state.raw<Snapshot[]>([{ turn: "initial" }]);
	// Plain (untracked) like the page's cacheFallbackConvId — data changes drive reconcile, not this.
	let cacheFallbackConvId: string | null = null;

	let messages: Snapshot[] = untrack(() => dataMessages);
	const applies: Snapshot[][] = [];

	let _lastSyncedConvId = untrack(() => convId);
	let _lastSyncedMessages = untrack(() => dataMessages);

	const cleanup = $effect.root(() => {
		$effect(() => {
			const currentConvId = convId; // reactive dep
			const newMessages = dataMessages; // reactive dep

			const convChanged = currentConvId !== _lastSyncedConvId;
			const dataChanged = newMessages !== _lastSyncedMessages;
			const cacheFallbackHere = untrack(() => cacheFallbackConvId) === currentConvId;

			if (
				shouldSyncMessagesFromData({
					convChanged,
					dataChanged,
					localTurnSyncHold: hold, // TRACKED — release re-runs the effect
					cacheFallbackHere,
					// This harness's `Snapshot` is `{ turn: string }`, never a Message[], so it cannot compute
					// the real `serverSnapshotHasAnswer`. False is the honest value: these tests pin ORDERINGS
					// around the hold, and the cache-fallback lift (CUR-1660) is pinned as a truth table in
					// generationState.spec.ts instead.
					snapshotHasAnswer: false,
					reportActionPending: reportHold, // TRACKED — CUR-1583, same release shape as hold
				})
			) {
				messages = newMessages;
				applies.push(newMessages);
				_lastSyncedConvId = currentConvId;
				_lastSyncedMessages = newMessages;
			}
		});
	});
	flushSync(); // initial effect run (no-op: nothing changed)

	return {
		cleanup,
		/** A load result landing on the page (an invalidation that APPLIED). */
		deliver(snapshot: Snapshot[]) {
			dataMessages = snapshot;
			flushSync();
		},
		setHold(value: boolean) {
			hold = value;
			flushSync();
		},
		setReportHold(value: boolean) {
			reportHold = value;
			flushSync();
		},
		navigate(id: string, snapshot: Snapshot[]) {
			convId = id;
			dataMessages = snapshot;
			flushSync();
		},
		setCacheFallback(id: string | null) {
			cacheFallbackConvId = id;
		},
		get messages() {
			return messages;
		},
		get applies() {
			return [...applies];
		},
		get current() {
			return untrack(() => dataMessages);
		},
	};
}

describe("message sync gate (ordered arrivals)", () => {
	test("a delivery during the hold is vetoed at delivery time, and bookkeeping is NOT advanced", () => {
		const gate = createGateHarness();
		gate.setHold(true);

		const stale: Snapshot[] = [{ turn: "A (previous turn's snapshot)" }];
		gate.deliver(stale);

		expect(gate.applies).toHaveLength(0);
		expect(gate.messages).not.toBe(stale);
		gate.cleanup();
	});

	test("multiple deliveries during the hold → release applies exactly once, with the LATEST identity", () => {
		const gate = createGateHarness();
		gate.setHold(true);

		gate.deliver([{ turn: "mid-stream stale 1" }]);
		const fresh: Snapshot[] = [{ turn: "post-turn fresh" }];
		gate.deliver(fresh);
		expect(gate.applies).toHaveLength(0);

		gate.setHold(false); // release re-runs the effect (tracked hold)

		expect(gate.applies).toHaveLength(1);
		expect(gate.messages).toBe(fresh);
		gate.cleanup();
	});

	test("release with no parked delivery is a no-op (identity constraint)", () => {
		const gate = createGateHarness();
		gate.setHold(true);
		gate.setHold(false);

		expect(gate.applies).toHaveLength(0);
		gate.cleanup();
	});

	test("setting the hold is a veto no-op — the flip itself can never apply a stale snapshot (2026-06-11 class)", () => {
		const gate = createGateHarness();
		const parked: Snapshot[] = [{ turn: "already delivered" }];
		gate.deliver(parked); // applied while idle (hold down)
		expect(gate.applies).toHaveLength(1);

		gate.setHold(true); // re-runs the effect; nothing changed → must not re-apply

		expect(gate.applies).toHaveLength(1);
		gate.cleanup();
	});

	test("a conversation change during the hold still paints (navigation always syncs)", () => {
		const gate = createGateHarness();
		gate.setHold(true);

		const other: Snapshot[] = [{ turn: "other conversation" }];
		gate.navigate("conv-2", other);

		expect(gate.messages).toBe(other);
		gate.cleanup();
	});

	test("hold never set (multi-tab / onMount-resume tab): every delivery applies as today", () => {
		const gate = createGateHarness();

		const first: Snapshot[] = [{ turn: "poller refresh 1" }];
		const second: Snapshot[] = [{ turn: "poller refresh 2" }];
		gate.deliver(first);
		gate.deliver(second);

		expect(gate.applies).toEqual([first, second]);
		gate.cleanup();
	});

	// A "Report a problem" submission on screen vetoes the resync the same way the
	// turn hold does — same release shape, independent trigger (see reportHold.ts). (CUR-1583)
	test("a delivery during a report hold is vetoed, and releasing the report hold applies it", () => {
		const gate = createGateHarness();
		gate.setReportHold(true);

		const fresh: Snapshot[] = [{ turn: "post-turn fresh" }];
		gate.deliver(fresh);
		expect(gate.applies).toHaveLength(0);

		gate.setReportHold(false);

		expect(gate.applies).toHaveLength(1);
		expect(gate.messages).toBe(fresh);
		gate.cleanup();
	});

	test("a conversation change during a report hold still paints (navigation always syncs)", () => {
		const gate = createGateHarness();
		gate.setReportHold(true);

		const other: Snapshot[] = [{ turn: "other conversation" }];
		gate.navigate("conv-2", other);

		expect(gate.messages).toBe(other);
		gate.cleanup();
	});

	test("cache-fallback conversation stays vetoed after release (its branch has no authoritative resync)", () => {
		const gate = createGateHarness();
		gate.setCacheFallback("conv-1");
		gate.setHold(true);
		gate.deliver([{ turn: "empty server snapshot" }]);
		gate.setHold(false);

		expect(gate.applies).toHaveLength(0);
		gate.cleanup();
	});

	test("superseded post-turn refresh: retry observes an apply, THEN release applies fresh — never the parked stale", async () => {
		const gate = createGateHarness();
		gate.setHold(true);

		const stale: Snapshot[] = [{ turn: "parked mid-stream" }];
		gate.deliver(stale); // vetoed, parked

		// The finally's refresh: attempt 1 is superseded (resolves WITHOUT applying — kit's
		// latest-wins token), attempt 2 applies the fresh post-turn snapshot.
		const fresh: Snapshot[] = [{ turn: "post-turn fresh" }];
		let attempt = 0;
		const observed = await refreshUntilApplied({
			getCurrent: () => gate.current,
			invalidate: async () => {
				attempt += 1;
				if (attempt === 2) gate.deliver(fresh);
			},
		});
		expect(observed).toBe(true);

		gate.setHold(false); // page releases only after the observed apply

		expect(gate.messages).toBe(fresh);
		expect(gate.applies).toEqual([fresh]); // the parked stale identity never applied
		gate.cleanup();
	});

	test("retry budget exhausted: release still happens and applies the parked identity — the INTENTIONAL liveness residual", async () => {
		// Pinned so a future change that widens this residual (or trades liveness away for a
		// permanent veto) fails a test. Requires 3 consecutive supersede-and-cancel races; any
		// later delivery self-heals.
		const gate = createGateHarness();
		gate.setHold(true);

		const parked: Snapshot[] = [{ turn: "parked mid-stream" }];
		gate.deliver(parked);

		const observed = await refreshUntilApplied({
			getCurrent: () => gate.current,
			invalidate: async () => {}, // every attempt superseded-and-canceled
		});
		expect(observed).toBe(false);

		gate.setHold(false); // liveness: release anyway

		expect(gate.applies).toEqual([parked]);
		gate.cleanup();
	});
});

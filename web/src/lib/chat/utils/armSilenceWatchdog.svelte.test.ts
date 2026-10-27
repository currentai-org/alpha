import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { armSilenceWatchdog } from "./generationState";

// CUR-708 (regression). Real browser (Chromium via vitest's browser project), not jsdom: the bug
// this guards against is Chrome's OWN timer-throttling behavior in a backgrounded tab, and a fake
// DOM can't tell us anything about whether a real `visibilitychange` listener actually wires up and
// fires the way `document.addEventListener` promises. `now` is injectable so each case controls
// "how much wall-clock time has actually passed" independently of whether the real setTimeout ever
// runs: a THROTTLED timer that never fires, as opposed to a timer that was never armed.
describe("armSilenceWatchdog — visibilitychange fallback for a throttled background timer (CUR-708)", () => {
	let originalVisibilityState: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
	});

	afterEach(() => {
		if (originalVisibilityState) {
			Object.defineProperty(document, "visibilityState", originalVisibilityState);
		}
	});

	function setVisibility(state: "visible" | "hidden") {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => state,
		});
	}

	it("fires via the ordinary timer when the tab stays foregrounded", () => {
		vi.useFakeTimers();
		try {
			const onFire = vi.fn();
			const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire });
			vi.advanceTimersByTime(999);
			expect(onFire).not.toHaveBeenCalled();
			vi.advanceTimersByTime(2);
			expect(onFire).toHaveBeenCalledTimes(1);
			watchdog.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not fire on visibilitychange before the timeout has actually elapsed", () => {
		let now = 0;
		const onFire = vi.fn();
		const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => now });
		now = 500; // well under the 1000ms threshold
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(onFire).not.toHaveBeenCalled();
		watchdog.dispose();
	});

	it("fires on visibilitychange when the timer's own callback never ran — the throttled-tab case", () => {
		// Simulate the worst case of Chrome's background-tab timer throttling: the setTimeout callback
		// never runs at all. If armSilenceWatchdog only had the timer, onFire would never fire here —
		// this is the exact gap the visibilitychange fallback exists to close.
		const realSetTimeout = globalThis.setTimeout;
		// @ts-expect-error deliberately breaking the timer to prove the fallback is what saves it
		globalThis.setTimeout = () => 0;
		try {
			let now = 0;
			const onFire = vi.fn();
			const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => now });
			now = 1500; // the tab was hidden this whole time — a real 1500ms has now passed
			setVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			expect(onFire).toHaveBeenCalledTimes(1);
			watchdog.dispose();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});

	it("ignores a visibilitychange while the tab is still hidden", () => {
		let now = 0;
		const onFire = vi.fn();
		const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => now });
		now = 5000;
		setVisibility("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(onFire).not.toHaveBeenCalled();
		watchdog.dispose();
	});

	it("rearm() resets the elapsed-time clock the visibilitychange fallback reads", () => {
		let now = 0;
		const onFire = vi.fn();
		const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => now });
		now = 1500;
		watchdog.rearm(); // a fresh inbound update — the turn is alive, not stalled
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(onFire).not.toHaveBeenCalled();
		watchdog.dispose();
	});

	it("sanity check: a bare setTimeout alone (the pre-fix shape) never recovers from this — the gap this file exists to close", () => {
		const realSetTimeout = globalThis.setTimeout;
		// @ts-expect-error deliberately breaking the timer, same throttled-tab scenario as above
		globalThis.setTimeout = () => 0;
		try {
			const onFire = vi.fn();
			// A plain watchdog without the fallback, inlined: setTimeout and nothing else.
			// Untyped on purpose: the stubbed setTimeout above returns `number`, the real one returns
			// NodeJS.Timeout under this project's mixed node+dom lib types, and clearTimeout accepts
			// either — the type is incidental to what this test is actually proving.
			let timer: unknown;
			const arm = () => {
				if (timer) clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
				timer = setTimeout(onFire, 1000);
			};
			arm();
			setVisibility("visible");
			document.dispatchEvent(new Event("visibilitychange"));
			// No fallback exists to read wall-clock time here, so a throttled timer just never fires.
			expect(onFire).not.toHaveBeenCalled();
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});

	it("dispose() removes the listener so a later visibilitychange can't fire it", () => {
		let now = 0;
		const onFire = vi.fn();
		const watchdog = armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => now });
		watchdog.dispose();
		now = 5000;
		setVisibility("visible");
		document.dispatchEvent(new Event("visibilitychange"));
		expect(onFire).not.toHaveBeenCalled();
	});
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { armSilenceWatchdog } from "./generationState";

// Real browser (Chromium via vitest's browser project), not jsdom: the watchdog listens for a real
// `visibilitychange` on the real document. Fake timers drive the timer, and `now` is the same fake
// clock, so each case controls exactly how long the page was visible and how long it was hidden.
//
// hidden time never counts toward the silence window. A phone that locks mid-answer comes
// back to the rest of its window, not to an instant fire that logs the turn as a dead connection.
// no timer runs while hidden, so a background tab's throttled timer cannot fire late either.
describe("armSilenceWatchdog — silence the visitor could see", () => {
	let originalVisibilityState: PropertyDescriptor | undefined;

	beforeEach(() => {
		originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
		vi.useFakeTimers({ now: 0 });
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalVisibilityState) {
			Object.defineProperty(document, "visibilityState", originalVisibilityState);
		} else {
			delete (document as { visibilityState?: unknown }).visibilityState;
		}
	});

	function setVisibility(state: "visible" | "hidden") {
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => state,
		});
		document.dispatchEvent(new Event("visibilitychange"));
	}

	const arm = (onFire: () => void) =>
		armSilenceWatchdog({ timeoutMs: 1000, onFire, now: () => Date.now() });

	it("fires after the full window of visible silence, and not a moment before", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		vi.advanceTimersByTime(999);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledTimes(1);
		expect(onFire).toHaveBeenCalledWith({ hiddenMs: 0 });
		watchdog.dispose();
	});

	it("never fires while the page stays hidden, however long the silence", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		vi.advanceTimersByTime(300);
		setVisibility("hidden");
		vi.advanceTimersByTime(60_000);
		expect(onFire).not.toHaveBeenCalled();
		watchdog.dispose();
	});

	it("does not fire on return from hidden: it resumes with what was left of the window", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		vi.advanceTimersByTime(300);
		setVisibility("hidden");
		vi.advanceTimersByTime(20_000);
		setVisibility("visible");
		// 300 ms of the window were spent before the lock; 700 ms remain, and only visible time counts.
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(699);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledTimes(1);
		watchdog.dispose();
	});

	it("reports the hidden time inside the silence that fired it, so the caller can tell a lock from a dead line", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		setVisibility("hidden");
		vi.advanceTimersByTime(20_000);
		setVisibility("visible");
		vi.advanceTimersByTime(1000);
		expect(onFire).toHaveBeenCalledWith({ hiddenMs: 20_000 });
		expect(watchdog.hiddenMs()).toBe(20_000);
		expect(watchdog.returnedFromHidden()).toBe(true);
		watchdog.dispose();
	});

	it("an update after the return re-arms a full window, and that window reports no hidden time", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		setVisibility("hidden");
		vi.advanceTimersByTime(20_000);
		setVisibility("visible");
		vi.advanceTimersByTime(500);
		watchdog.rearm(); // the stream is alive: its buffered update arrived
		vi.advanceTimersByTime(999);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledWith({ hiddenMs: 0 });
		// The turn's own total still remembers the lock.
		expect(watchdog.hiddenMs()).toBe(20_000);
		watchdog.dispose();
	});

	it("an update that arrives while hidden restarts the window without starting a timer", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		vi.advanceTimersByTime(900);
		setVisibility("hidden");
		vi.advanceTimersByTime(5000);
		watchdog.rearm();
		vi.advanceTimersByTime(5000);
		expect(onFire).not.toHaveBeenCalled();
		setVisibility("visible");
		// The window restarted at the update, so the 900 ms spent before hiding no longer count.
		vi.advanceTimersByTime(999);
		expect(onFire).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onFire).toHaveBeenCalledWith({ hiddenMs: 5000 });
		expect(watchdog.hiddenMs()).toBe(10_000);
		watchdog.dispose();
	});

	it("armed while the page is already hidden, it starts counting only once the page shows", () => {
		setVisibility("hidden");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		vi.advanceTimersByTime(30_000);
		expect(onFire).not.toHaveBeenCalled();
		setVisibility("visible");
		vi.advanceTimersByTime(1000);
		expect(onFire).toHaveBeenCalledWith({ hiddenMs: 30_000 });
		watchdog.dispose();
	});

	it("a turn that was never hidden reports no hidden time and no return", () => {
		setVisibility("visible");
		const watchdog = arm(vi.fn());
		vi.advanceTimersByTime(500);
		expect(watchdog.hiddenMs()).toBe(0);
		expect(watchdog.returnedFromHidden()).toBe(false);
		watchdog.dispose();
	});

	it("dispose() removes the listener and the timer, so nothing fires after the turn ends", () => {
		setVisibility("visible");
		const onFire = vi.fn();
		const watchdog = arm(onFire);
		setVisibility("hidden");
		watchdog.dispose();
		setVisibility("visible");
		vi.advanceTimersByTime(5000);
		expect(onFire).not.toHaveBeenCalled();
	});
});

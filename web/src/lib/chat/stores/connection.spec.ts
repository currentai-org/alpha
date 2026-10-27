import { describe, it, expect, vi, afterEach } from "vitest";
import { get } from "svelte/store";
import { deriveConnectionState, createConnectionStore } from "./connection";

// `streaming: true` in the base: the staleness tests model a turn that IS actively streaming (the
// only time heartbeats are expected). The idle case is covered explicitly below.
const base = { navigatorOnline: true, lastPingAgoMs: 0 as number | null, streaming: true };

describe("deriveConnectionState", () => {
	it("is online when navigator is online and heartbeat is fresh", () => {
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 1000 })).toBe("online");
	});

	it("offline when navigator reports offline, regardless of heartbeat", () => {
		expect(deriveConnectionState({ ...base, navigatorOnline: false, lastPingAgoMs: 0 })).toBe(
			"offline"
		);
	});

	it("reconnecting when heartbeat is stale past the reconnect threshold (while streaming)", () => {
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 9000 })).toBe("reconnecting");
	});

	it("unreachable (not offline) when heartbeat is stale past the offline threshold while the client is online", () => {
		// Wired client (navigator.onLine true) whose heartbeat has gone stale: that's OUR server failing
		// to answer, never "you're offline". The two causes must stay distinct so the copy can too.
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 25000 })).toBe("unreachable");
	});

	it("still says 'offline' (not 'unreachable') when navigator is the thing that's down", () => {
		// navigator-offline outranks heartbeat staleness: the client's own network is genuinely down, so
		// the actionable "reconnect" copy is correct even mid-stream.
		expect(
			deriveConnectionState({ ...base, navigatorOnline: false, lastPingAgoMs: 25000 })
		).toBe("offline");
	});

	// An idle connection emits no heartbeats by design, so its ping age climbs forever. Staleness must NOT
	// be read while idle — otherwise a healthy connection flips to offline ~20s after each answer finishes.
	it("idle (not streaming): stale heartbeat does NOT surface reconnecting or offline", () => {
		expect(deriveConnectionState({ ...base, streaming: false, lastPingAgoMs: 9000 })).toBe(
			"online"
		);
		expect(deriveConnectionState({ ...base, streaming: false, lastPingAgoMs: 60000 })).toBe(
			"online"
		);
	});

	it("idle still honors hard signals: navigator-offline and slow links surface even when not streaming", () => {
		expect(
			deriveConnectionState({ ...base, streaming: false, navigatorOnline: false, lastPingAgoMs: 0 })
		).toBe("offline");
		expect(
			deriveConnectionState({ ...base, streaming: false, lastPingAgoMs: 60000, saveData: true })
		).toBe("slow");
	});

	it("does NOT flash reconnecting before the first heartbeat (null age is healthy)", () => {
		expect(
			deriveConnectionState({ navigatorOnline: true, lastPingAgoMs: null, streaming: true })
		).toBe("online");
	});

	it("slow on save-data or 2g-class links when otherwise healthy", () => {
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 500, saveData: true })).toBe("slow");
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 500, effectiveType: "slow-2g" })).toBe(
			"slow"
		);
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 500, effectiveType: "2g" })).toBe(
			"slow"
		);
	});

	it("staleness outranks link-quality (reconnecting beats slow)", () => {
		expect(deriveConnectionState({ ...base, lastPingAgoMs: 9000, effectiveType: "slow-2g" })).toBe(
			"reconnecting"
		);
	});

	it("honors custom thresholds", () => {
		expect(
			deriveConnectionState({ ...base, lastPingAgoMs: 3000 }, { reconnectingAfterMs: 2000 })
		).toBe("reconnecting");
	});
});

// The store is where the false-offline brittleness lives or dies: a captive-portal / wifi
// re-auth flips navigator.onLine to false for a fraction of a second. The debounce must keep
// that flicker from ever flashing the alarming "offline" banner, while a real recovery must
// surface instantly. These exercise that wiring (the reducer above is pure; this is the timers).
describe("createConnectionStore", () => {
	let listeners: Record<string, Array<() => void>>;
	function setupBrowser(onLine = true) {
		listeners = {};
		vi.stubGlobal("window", {
			addEventListener: (ev: string, cb: () => void) => void (listeners[ev] ??= []).push(cb),
			removeEventListener: (ev: string, cb: () => void) =>
				void (listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== cb)),
		});
		const nav = { onLine };
		vi.stubGlobal("navigator", nav);
		return { nav, fire: (ev: string) => (listeners[ev] ?? []).forEach((f) => f()) };
	}
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("no-ops safely with no browser (SSR): yields online, notePing is harmless", () => {
		// No window/navigator stubbed → SSR branch.
		vi.unstubAllGlobals();
		const { state, notePing } = createConnectionStore();
		expect(get(state)).toBe("online");
		expect(() => notePing()).not.toThrow();
	});

	it("a brief navigator-offline flicker that recovers within the debounce never surfaces 'offline'", () => {
		vi.useFakeTimers();
		const { nav, fire } = setupBrowser(true);
		const { state, notePing } = createConnectionStore({ debounceMs: 1500, tickMs: 2000 });
		const seen: string[] = [];
		const unsub = state.subscribe((s) => seen.push(s));
		notePing();

		nav.onLine = false;
		fire("offline"); // schedules the degraded state behind the 1.5s debounce
		vi.advanceTimersByTime(500); // still within the debounce window
		nav.onLine = true;
		fire("online"); // recovery cancels the pending degraded surface

		vi.advanceTimersByTime(3000);
		unsub();
		expect(seen).not.toContain("offline");
		expect(get(state)).toBe("online");
	});

	it("a sustained navigator-offline surfaces 'offline' after the debounce", () => {
		vi.useFakeTimers();
		const { nav, fire } = setupBrowser(true);
		const { state, notePing } = createConnectionStore({ debounceMs: 1500 });
		const unsub = state.subscribe(() => {});
		notePing();

		nav.onLine = false;
		fire("offline");
		expect(get(state)).toBe("online"); // not yet — debounced
		vi.advanceTimersByTime(1500);
		expect(get(state)).toBe("offline");
		unsub();
	});

	it("recovery to online applies immediately (no debounce on the way back)", () => {
		vi.useFakeTimers();
		const { nav, fire } = setupBrowser(false);
		const { state } = createConnectionStore({ debounceMs: 1500 });
		const unsub = state.subscribe(() => {});
		vi.advanceTimersByTime(1500);
		expect(get(state)).toBe("offline");

		nav.onLine = true;
		fire("online");
		expect(get(state)).toBe("online"); // immediate, same tick
		unsub();
	});

	it("heartbeat staleness surfaces 'reconnecting' via the poll tick once past threshold", () => {
		vi.useFakeTimers();
		setupBrowser(true);
		const { state, notePing } = createConnectionStore({
			debounceMs: 1500,
			tickMs: 2000,
			reconnectingAfterMs: 8000,
		});
		const unsub = state.subscribe(() => {});
		notePing(); // fresh heartbeat at t0
		vi.advanceTimersByTime(6000);
		expect(get(state)).toBe("online"); // still fresh enough
		vi.advanceTimersByTime(4000); // now > 8s stale; a poll tick recomputes
		vi.advanceTimersByTime(1500); // debounce surfaces it
		expect(get(state)).toBe("reconnecting");
		unsub();
	});

	// Store level: a turn streams, then SETTLES, then the user reads for a minute. Without the
	// stream-settled disarm this flips to "offline" ~20s in. With it, an idle healthy connection stays
	// "online" no matter how long the silence runs.
	it("after a stream settles, idle silence never surfaces reconnecting/offline", () => {
		vi.useFakeTimers();
		setupBrowser(true);
		const { state, notePing, noteStreamSettled } = createConnectionStore({
			debounceMs: 1500,
			tickMs: 2000,
			reconnectingAfterMs: 8000,
			offlineAfterMs: 20000,
		});
		const seen: string[] = [];
		const unsub = state.subscribe((s) => seen.push(s));
		notePing(); // a token arrives mid-stream
		noteStreamSettled(); // the answer finishes
		vi.advanceTimersByTime(60000); // user reads for a full minute of ping-silence
		expect(get(state)).toBe("online");
		expect(seen).not.toContain("reconnecting");
		expect(seen).not.toContain("unreachable");
		expect(seen).not.toContain("offline");
		unsub();
	});
});

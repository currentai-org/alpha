// Connectivity state for the poor-connectivity UX layer. The honest signal of "can we
// reach the server" is NOT navigator.onLine (it reports true on captive-portal wifi that
// can't actually reach us) — it's the liveness of our own heartbeat (the /updates SSE
// emits one; the consumer calls notePing() on each). navigator.onLine is used only as a
// fast coarse "offline" hint, never to gate sends. The Network Information API
// (effectiveType/saveData) is progressive enhancement (Chromium/Android-mostly).
//
// The state machine is a PURE reducer (deriveConnectionState) so it's unit-testable with
// no DOM; the store wiring (createConnectionStore) attaches it to browser events + a
// heartbeat staleness timer, with debounce so a sub-second micro-drop never flashes UI.

import { readable, type Readable } from "svelte/store";

// "offline" vs "unreachable" is a deliberate split: "offline" means navigator.onLine is false —
// the CLIENT's own network is down, so "you're offline, reconnect" is the honest, actionable copy.
// "unreachable" means the client is demonstrably online but OUR heartbeat has gone stale mid-stream —
// the SERVER isn't answering, not the user's wifi. Telling an ethernet user "you're offline" when it's
// our backend stalling is the misleading toast this split avoids; the two carry different copy.
export type ConnectionState = "online" | "slow" | "reconnecting" | "unreachable" | "offline";

export interface ConnectionInputs {
	/** navigator.onLine (coarse; a false here is trustworthy, a true is not). */
	navigatorOnline: boolean;
	/** ms since the last heartbeat ping, or null if we've never seen one yet. */
	lastPingAgoMs: number | null;
	/**
	 * Whether a generation is actively streaming right now (i.e. we EXPECT heartbeats). The heartbeat
	 * only emits during a stream — so when idle, ping silence is not evidence of trouble, it's the
	 * normal state. Judging staleness while idle is exactly the bug that declared a healthy connection
	 * "offline" ~20s after every answer finished. Staleness is read ONLY while this is true.
	 */
	streaming: boolean;
	/** Network Information effectiveType, if available ("slow-2g"|"2g"|"3g"|"4g"). */
	effectiveType?: string | null;
	/** Network Information saveData flag, if available. */
	saveData?: boolean | null;
}

export interface ConnectionThresholds {
	/** Heartbeat silence beyond this (ms) → "reconnecting". Default 8000. */
	reconnectingAfterMs?: number;
	/** Heartbeat silence beyond this (ms) → "offline". Default 20000. */
	offlineAfterMs?: number;
}

/**
 * Pure state derivation. Order matters: hard-offline (navigator) first, then heartbeat staleness,
 * then link-quality. A stale heartbeat while streaming surfaces as "unreachable" (server not
 * answering), NEVER "offline" — "offline" is reserved for navigator.onLine === false so an online
 * user is never told their own network is down when it's our backend stalling. `lastPingAgoMs ===
 * null` (no heartbeat yet) is treated as healthy so a fresh page doesn't flash "reconnecting" before
 * the first ping arrives. Heartbeat staleness is read ONLY while `streaming` — idle ping-silence is
 * the normal state, not a failure (judging it is what falsely flipped a healthy idle connection to a
 * degraded state after each answer completed).
 */
export function deriveConnectionState(
	input: ConnectionInputs,
	thresholds: ConnectionThresholds = {}
): ConnectionState {
	const { reconnectingAfterMs = 8000, offlineAfterMs = 20000 } = thresholds;
	const { navigatorOnline, lastPingAgoMs, streaming, effectiveType, saveData } = input;

	if (!navigatorOnline) return "offline";
	if (streaming && lastPingAgoMs !== null) {
		// Client is online (navigator said so above) but our heartbeat has gone quiet: the SERVER is
		// unreachable, not the user's network — so "unreachable", not "offline".
		if (lastPingAgoMs >= offlineAfterMs) return "unreachable";
		if (lastPingAgoMs >= reconnectingAfterMs) return "reconnecting";
	}
	if (saveData === true || effectiveType === "slow-2g" || effectiveType === "2g") return "slow";
	return "online";
}

interface ConnectionStoreOptions extends ConnectionThresholds {
	/** Poll cadence for re-deriving from heartbeat age (ms). Default 2000. */
	tickMs?: number;
	/** Debounce before surfacing a non-"online" state (ms), so micro-drops don't flash. Default 1500. */
	debounceMs?: number;
}

/**
 * Browser store. Returns a readable<ConnectionState> plus `notePing()` to call from the
 * heartbeat consumer. SSR-safe: yields "online" and no-ops without a browser.
 */
export function createConnectionStore(opts: ConnectionStoreOptions = {}): {
	state: Readable<ConnectionState>;
	notePing: () => void;
	noteStreamSettled: () => void;
} {
	const { tickMs = 2000, debounceMs = 1500, ...thresholds } = opts;

	if (typeof window === "undefined") {
		return {
			state: readable<ConnectionState>("online"),
			notePing: () => {},
			noteStreamSettled: () => {},
		};
	}

	let lastPing: number | null = null;
	let streaming = false;
	// A heartbeat both refreshes liveness AND marks us as actively streaming (heartbeats only emit
	// mid-stream). notePing fires per inbound chunk.
	const notePing = () => {
		streaming = true;
		lastPing = Date.now();
	};
	// The stream ended (cleanly, by user-stop, by navigation, or by error). Stop expecting heartbeats
	// so idle ping-silence can't be read as a failure; clear the stale timestamp too. The caller
	// surfaces any real mid-stream error itself, so dropping back to the coarse signal here is correct.
	const noteStreamSettled = () => {
		streaming = false;
		lastPing = null;
	};

	const inputs = (): ConnectionInputs => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const conn = (navigator as any).connection ?? null;
		return {
			navigatorOnline: navigator.onLine,
			lastPingAgoMs: lastPing === null ? null : Date.now() - lastPing,
			streaming,
			effectiveType: conn?.effectiveType ?? null,
			saveData: conn?.saveData ?? null,
		};
	};

	const state = readable<ConnectionState>("online", (set) => {
		let current: ConnectionState = "online";
		let pendingTimer: ReturnType<typeof setTimeout> | undefined;

		const clearPending = () => {
			if (pendingTimer) {
				clearTimeout(pendingTimer);
				pendingTimer = undefined;
			}
		};

		const apply = (next: ConnectionState) => {
			if (next === current) {
				clearPending();
				return;
			}
			// "online" (recovery) applies immediately; degraded states debounce so a brief
			// blip never flashes the banner.
			if (next === "online") {
				clearPending();
				current = next;
				set(next);
				return;
			}
			if (pendingTimer) return; // already waiting to surface a degraded state
			pendingTimer = setTimeout(() => {
				pendingTimer = undefined;
				current = next;
				set(next);
			}, debounceMs);
		};

		const recompute = () => apply(deriveConnectionState(inputs(), thresholds));

		const onOnline = () => recompute();
		const onOffline = () => recompute();
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		const interval = setInterval(recompute, tickMs);
		recompute();

		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
			clearInterval(interval);
			if (pendingTimer) clearTimeout(pendingTimer);
		};
	});

	return { state, notePing, noteStreamSettled };
}

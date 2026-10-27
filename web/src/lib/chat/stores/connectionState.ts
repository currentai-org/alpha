// Single shared connectivity store for the UI layer. The MVP derives state from
// navigator.onLine + the Network Information API (offline / slow); the heartbeat-fed
// "reconnecting" path stays dormant until the stream watchdog (agent-service's +page.svelte
// seam) feeds it liveness via noteHeartbeat() — at which point a mid-stream stall surfaces
// as "reconnecting" without any change here. One instance so every consumer (the indicator
// component, and later the stream consumer) reads/writes the same store.

import { createConnectionStore } from "./connection";

const store = createConnectionStore();

/** Readable<ConnectionState> — "online" | "slow" | "reconnecting" | "unreachable" | "offline". */
export const connectionState = store.state;

/** Call on each liveness signal (SSE heartbeat / first stream token). Wired by the stream
 *  consumer later; until then the store runs on navigator.onLine + Network Info alone. */
export const noteHeartbeat = store.notePing;

/** Call when a generation stream ends (cleanly, stopped, navigated away, or errored). Disarms the
 *  heartbeat-staleness watchdog so an idle connection — which emits no heartbeats by design — is
 *  never mistaken for a dropped one. Without this, staleness climbs unbounded after each answer
 *  and flips a healthy connection to "reconnecting"/"offline" ~8–20s later. */
export const noteStreamSettled = store.noteStreamSettled;

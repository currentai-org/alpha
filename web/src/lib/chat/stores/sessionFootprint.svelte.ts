/**
 * Client-owned "session footprint" store: how long you've ACTIVELY been here and an honest
 * ESTIMATE of the energy this session has cost. Both are deliberate anti-engagement /
 * transparency signals (see SessionFootprint.svelte for the framing).
 *
 * SSR safety: like the conversations store, this exports a factory + context helpers and
 * holds no module-level mutable $state, so concurrent SSR requests never share data.
 * The factory is called once from +layout.svelte; consumers (the footprint component and
 * the conversation page) read it via useSessionFootprintStore().
 *
 * Persistence: scoped to the browser TAB via sessionStorage, so "this session" resets
 * when the tab closes — the honest unit for a no-login guest alpha. We persist the session
 * start, the accumulated ACTIVE milliseconds, and a running output-token tally.
 *
 * ACTIVE TIME, not wall-clock: a tab left open for 49 hours must not read 49h. The clock only
 * accrues while this tab is BOTH visible AND not idle, so a tab left
 * in the background, or sitting untouched on a second monitor, doesn't inflate "time spent
 * with the AI." The displayed number answers "how long was I actually engaged," which is the
 * only honest reading of a transparency mirror. This is a per-session figure; it is not an
 * account-cumulative total.
 */

import { browser } from "$app/environment";
import { getContext, setContext } from "svelte";
import { estimateTokensFromText, estimateEnergyWh } from "$lib/chat/utils/energyEstimate";

export const SESSION_FOOTPRINT_CONTEXT_KEY = "sessionFootprintStore";

const STORAGE_KEY = "ap:session-footprint";
// Recompute elapsed time on a calm cadence — minutes-granular display means a 30s tick is
// plenty, and a slow tick is itself the anti-engagement stance (no ticking second hand).
const TICK_MS = 30_000;
// Pause active accrual after this long with no interaction, even while the tab is visible —
// covers the "visible but unattended on another monitor" case. Generous on purpose: any
// pointer/key/scroll, a streamed reply, or refocusing the tab all count as activity and
// resume it, so reading a long answer (you scroll) never trips it; only walking away does.
const IDLE_MS = 120_000;

interface PersistedFootprint {
	startedAt: number;
	outputTokens: number;
	activeMs: number;
}

class SessionFootprintStore {
	#startedAt = $state(0);
	#outputTokens = $state(0);
	// Accumulated ACTIVE time (persisted). The live, currently-accruing span is added on read.
	#activeMs = $state(0);
	// Live "now", bumped on an interval so elapsed time stays current without a per-second
	// re-render. Seeded at construction; 0 on the server (component guards on browser).
	#now = $state(0);

	// Active-accrual bookkeeping (plain, non-reactive — they drive #activeMs/#now which ARE
	// reactive). #resumeAt is the timestamp the current active span began, or 0 when paused.
	#resumeAt = 0;
	#lastInteractionAt = 0;
	#idleTimer: ReturnType<typeof setTimeout> | undefined;
	// Demo mode: seeded figures, never read from or written to sessionStorage (so the /alpha demo
	// can't leak into, or inherit from, the visitor's real chat session).
	#ephemeral = false;

	constructor(seed?: FootprintSeed) {
		if (!browser) return;

		if (seed) this.#ephemeral = true;
		const persisted = seed
			? { startedAt: Date.now() - seed.activeMs, outputTokens: seed.outputTokens, activeMs: seed.activeMs }
			: this.#load();
		if (persisted) {
			this.#startedAt = persisted.startedAt;
			this.#outputTokens = persisted.outputTokens;
			this.#activeMs = persisted.activeMs;
		} else {
			this.#startedAt = Date.now();
			this.#persist();
		}
		this.#now = Date.now();
		this.#lastInteractionAt = Date.now();

		// One interval for the lifetime of the layout instance; no teardown needed since the
		// store lives as long as the app shell does. DEFENSIVE: this tick is what makes the clock
		// tolerate throttled/missed timers — if we've gone idle (no interaction for IDLE_MS) or the
		// tab is hidden, fold + stop here rather than trusting the per-interaction setTimeout (which
		// background tabs throttle heavily). Otherwise just advance #now so the live display ticks.
		setInterval(() => {
			if (this.#resumeAt === 0) return;
			if (!browser) return;
			if (document.hidden || Date.now() - this.#lastInteractionAt >= IDLE_MS) this.#pause();
			else this.#now = Date.now();
		}, TICK_MS);

		// Visibility gates accrual: leaving the tab pauses the clock, returning resumes it (and
		// snaps #now current, since background tabs throttle the interval and read stale).
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") this.#registerActivity();
			else this.#pause();
		});

		// Intentional interactions count as presence. Deliberately NOT pointermove — a cursor merely
		// resting over the window emits a stream of pointermove events (OS jitter), which would keep
		// the clock alive with no real engagement and inflate the timer toward wall-clock. Clicks,
		// keys, scroll, and touch are deliberate; reading a long reply scrolls (and a streamed reply
		// itself marks activity via recordResponse), so genuine engagement is still captured.
		for (const ev of ["pointerdown", "keydown", "scroll", "wheel", "touchstart"] as const) {
			window.addEventListener(ev, () => this.#registerActivity(), { passive: true });
		}

		// Start accruing immediately if we're already foregrounded.
		if (document.visibilityState === "visible") this.#registerActivity();
	}

	/** Mark presence: resume the active span (if visible) and push the idle deadline out.
	 *  Throttled to ~1/s so high-frequency pointermove doesn't churn timers. */
	#registerActivity(): void {
		const t = Date.now();
		if (t - this.#lastInteractionAt < 1000 && this.#resumeAt !== 0) return;
		this.#lastInteractionAt = t;
		if (document.visibilityState === "visible") this.#resume();
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => this.#pause(), IDLE_MS);
	}

	#resume(): void {
		if (this.#resumeAt === 0) {
			this.#resumeAt = Date.now();
			this.#now = Date.now();
		}
	}

	/** Fold the current active span into the accumulated total and stop the clock. The span is
	 *  CAPPED at the idle horizon (last interaction + IDLE_MS): if the tab sat idle/hidden and the
	 *  pause fired late (throttled timer), we never count the dead time past the horizon. */
	#pause(): void {
		clearTimeout(this.#idleTimer);
		if (this.#resumeAt === 0) return;
		const end = Math.min(Date.now(), this.#lastInteractionAt + IDLE_MS);
		this.#activeMs += Math.max(0, end - this.#resumeAt);
		this.#resumeAt = 0;
		this.#now = Date.now();
		this.#persist();
	}

	#load(): PersistedFootprint | null {
		try {
			const raw = sessionStorage.getItem(STORAGE_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as Partial<PersistedFootprint>;
			if (typeof parsed.startedAt !== "number" || typeof parsed.outputTokens !== "number") {
				return null;
			}
			// activeMs added later; default 0 for pre-existing tab sessions.
			const activeMs = typeof parsed.activeMs === "number" ? parsed.activeMs : 0;
			return { startedAt: parsed.startedAt, outputTokens: parsed.outputTokens, activeMs };
		} catch {
			return null;
		}
	}

	#persist(): void {
		if (!browser || this.#ephemeral) return;
		try {
			sessionStorage.setItem(
				STORAGE_KEY,
				JSON.stringify({
					startedAt: this.#startedAt,
					outputTokens: this.#outputTokens,
					activeMs: this.#activeMs,
				})
			);
		} catch {
			// sessionStorage can throw (private mode / quota); the footprint is best-effort.
		}
	}

	/** Whether the session clock has started (always true in the browser, false on SSR). */
	get started(): boolean {
		return this.#startedAt > 0;
	}

	/** Active milliseconds this session — time the tab was visible and engaged, NOT wall-clock. The
	 *  live (un-folded) span is CAPPED at the idle horizon so the display can't run away even if the
	 *  pause timer is throttled: it never reads more than IDLE_MS past the last interaction. */
	get elapsedMs(): number {
		if (this.#startedAt === 0) return 0;
		let live = 0;
		if (this.#resumeAt !== 0) {
			const end = Math.min(this.#now, this.#lastInteractionAt + IDLE_MS);
			live = Math.max(0, end - this.#resumeAt);
		}
		return this.#activeMs + live;
	}

	/** Whether any assistant response has been recorded yet (gates energy display). */
	get hasActivity(): boolean {
		return this.#outputTokens > 0;
	}

	get outputTokens(): number {
		return this.#outputTokens;
	}

	/** Estimated energy for the session so far, in Wh. */
	get energyWh(): number {
		return estimateEnergyWh(this.#outputTokens);
	}

	/**
	 * Record a completed assistant response. We have no real token usage, so we estimate
	 * from the final text length (see energyEstimate). Called once per FinalAnswer.
	 */
	recordResponse(text: string): void {
		const tokens = estimateTokensFromText(text);
		if (tokens <= 0) return;
		this.#outputTokens += tokens;
		// A reply landing is itself presence — keep the active clock running through a long
		// answer the user is reading even if they haven't touched the mouse.
		if (browser) this.#registerActivity();
		this.#persist();
	}

	/**
	 * Wipe the footprint and start a fresh session — called when the user clears all their data
	 * (the trash-all GDPR wipe), so the ambient timer + energy reset visibly alongside everything
	 * else. Purely cosmetic (the footprint is client-only, never sent anywhere), but a clean reset
	 * shouldn't leave a stale "2h · 0.3 Wh" hanging in the corner.
	 */
	reset(): void {
		if (!browser) return;
		this.#pause(); // fold/stop any in-flight active span first
		this.#activeMs = 0;
		this.#outputTokens = 0;
		this.#startedAt = Date.now();
		this.#resumeAt = 0;
		this.#lastInteractionAt = Date.now();
		this.#now = Date.now();
		this.#persist();
		if (document.visibilityState === "visible") this.#registerActivity();
	}
}

/** Fixed starting figures for a demo footprint (the /alpha sample session). */
export interface FootprintSeed {
	outputTokens: number;
	activeMs: number;
}

export function createSessionFootprintStore(seed?: FootprintSeed): SessionFootprintStore {
	const store = new SessionFootprintStore(seed);
	setContext(SESSION_FOOTPRINT_CONTEXT_KEY, store);
	return store;
}

export function useSessionFootprintStore(): SessionFootprintStore {
	const store = getContext<SessionFootprintStore | undefined>(SESSION_FOOTPRINT_CONTEXT_KEY);
	if (!store) {
		throw new Error(
			"useSessionFootprintStore must be used within a component tree that called createSessionFootprintStore (see +layout.svelte)."
		);
	}
	return store;
}

export type { SessionFootprintStore };

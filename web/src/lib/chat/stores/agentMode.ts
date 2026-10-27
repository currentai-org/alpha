import { browser } from "$app/environment";
import { get, writable } from "svelte/store";

// Should a turn run through the Public AI AGENT (multi-step plan/exec on the open Apertus model) instead
// of a single model completion? Three states, mirroring the speak control's off/auto/always shape:
//   off  — never route to the agent (THE DEFAULT — like web search / speak, a page that quietly fans out
//          a turn to a slow multi-step backend is surprising; opt in). The selected model answers.
//   auto — ask the agent service's /route classifier (Apertus + the bare forced-choice harness trick)
//          whether THIS turn benefits from agentic work, and route only if so. The "it just knew" mode.
//   on   — force every turn through the agent (the power-user setting; pays the multi-step cost
//          even on a trivial turn).
//
// Direction: as the model itself learns to decide mid-stream (emit a hand-off tool call), "auto"
// becomes the default and this toggle collapses to an override. Keeping it a 3-state seam now means that
// shift is a change to what "auto" calls, not to the UI or the wire contract. See the server resolveAgentRoute.
//
// Lightweight client-only preference in localStorage (like webSearchAllowed / speakMode) — not server-synced.
export type AgentMode = "off" | "auto" | "on";

const KEY = "ap:agentMode";
const ORDER: AgentMode[] = ["off", "auto", "on"];

function readStored(): AgentMode | null {
	if (!browser) return null;
	try {
		const v = localStorage.getItem(KEY);
		return v && (ORDER as string[]).includes(v) ? (v as AgentMode) : null;
	} catch {
		return null;
	}
}

// Captured ONCE, at module load, before anything below can write to the key — see applyServerDefault's
// comment for why this can't be a live re-read.
const storedAtLoad = readStored();

const INITIAL_VALUE: AgentMode = storedAtLoad ?? "off";

export const agentMode = writable<AgentMode>(INITIAL_VALUE);

/** Next state in the off → auto → on → off cycle (for the composer's cycling control). */
export function nextAgentMode(m: AgentMode): AgentMode {
	return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

if (browser) {
	// Module-level, not component-scoped: this runs for the whole page session with nothing to key
	// an unmount off of (mirrors speakMode.ts/webSearchMode.ts's identical idiom). The unsubscribe
	// this rule wants captured would never be called anyway.
	// Bare disable (no rule name): this rule only exists in the main eslint config, which loads
	// eslint-plugin-svelte -- eslint.quality.config.js lints this same file WITHOUT that plugin, and
	// a disable comment naming an unregistered rule is a hard error there, not a no-op.
	// eslint-disable-next-line
	agentMode.subscribe((v) => {
		try {
			localStorage.setItem(KEY, v);
		} catch {
			/* private mode / quota — preference just won't persist */
		}
	});
}

/**
 * Seed a cleared tester's first-ever visit into "auto" instead of "off" (CUR-770). Call once, e.g. from
 * the layout's onMount, with `page.data.agentModeDefault`.
 *
 * Fires ONLY when localStorage had never been written at the moment this module first loaded —
 * `storedAtLoad`, not a live re-read. A live re-read would always find a value: the subscribe above
 * fires once immediately on subscription with the CURRENT value, so by the time any caller gets around
 * to checking, the module has already written "off" (or whatever `storedAtLoad` was) back to storage
 * itself, making a live "is it still unset" check trivially and permanently false. `storedAtLoad`
 * freezes the answer before that self-write can happen, which is the only way to actually distinguish
 * "never chosen" from "chose off."
 *
 * `storedAtLoad` alone is NOT enough to keep "an explicit past choice always wins" true on a
 * FIRST-EVER visit (CUR-1067): it is frozen at MODULE load (script evaluation, before any component
 * exists), not at the time this function actually runs. This is called from ChatShell's onMount, and
 * Svelte fires a child component's onMount BEFORE its parent's, so the composer's Agent toggle is
 * already mounted and clickable while this call is still pending. A toggle clicked to "on" within that
 * window would read "Agent: on" in the DOM while the next request carried `agentMode:"auto"`, because
 * `storedAtLoad` (frozen before the click) still reads `null` and this function resets the store.
 * Guard on the LIVE value instead: if the store no longer holds `INITIAL_VALUE`, something has already
 * changed it since this module loaded — a click that landed before this call gets to run — and that
 * must win exactly the same way a value restored from localStorage already does.
 */
export function applyServerDefault(serverDefault: AgentMode): void {
	if (!browser || serverDefault === "off" || storedAtLoad !== null) return;
	if (get(agentMode) !== INITIAL_VALUE) return;
	agentMode.set(serverDefault);
}

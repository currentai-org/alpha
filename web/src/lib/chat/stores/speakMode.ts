import { browser } from "$app/environment";
import { writable } from "svelte/store";

// How much should the chat speak its answers aloud (via the open TTS component)? Three states, mirroring
// the web-search control's off/auto/always shape:
//   off    — synthesize NOTHING (THE DEFAULT — new users always start here, see initial()). The server
//            runs no read-aloud/TTS path this turn — not even for an explicit "read this aloud" (that
//            requires auto/always). The client also never autoplays. So "off" means genuinely silent.
//            (The server enforces this via effectiveSpeakMode in textGeneration — the toggle is not
//            merely a client autoplay gate.)
//   auto   — speak when the router decides a turn is a read-aloud request (capable behavior, opt-in).
//   always — synthesize + speak EVERY answer. Off by default; this is an "open voice on everything" demo,
//            NOT an accessibility feature (a real screen reader does that better). Costs a TTS round-trip
//            per answer, so it's opt-in.
// Lightweight client-only preference in localStorage (like webSearchAllowed) — not a server-synced setting.
export type SpeakMode = "off" | "auto" | "always";

const KEY = "ap:speakMode";
const ORDER: SpeakMode[] = ["off", "auto", "always"];

function initial(): SpeakMode {
	if (!browser) return "off";
	try {
		const v = localStorage.getItem(KEY);
		return v && (ORDER as string[]).includes(v) ? (v as SpeakMode) : "off";
	} catch {
		return "off";
	}
}

export const speakMode = writable<SpeakMode>(initial());

/** Next state in the off → auto → always → off cycle (for the composer's cycling control). */
export function nextSpeakMode(m: SpeakMode): SpeakMode {
	return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

if (browser) {
	// Module-level, not component-scoped: this runs for the whole page session with nothing to key
	// an unmount off of (mirrors agentMode.ts/webSearchMode.ts's identical idiom). The unsubscribe
	// this rule wants captured would never be called anyway.
	// Bare disable (no rule name): this rule only exists in the main eslint config, which loads
	// eslint-plugin-svelte -- eslint.quality.config.js lints this same file WITHOUT that plugin, and
	// a disable comment naming an unregistered rule is a hard error there, not a no-op.
	// eslint-disable-next-line
	speakMode.subscribe((v) => {
		try {
			localStorage.setItem(KEY, v);
		} catch {
			/* private mode / quota — preference just won't persist */
		}
	});
}

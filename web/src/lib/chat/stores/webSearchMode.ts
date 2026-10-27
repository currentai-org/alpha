import { browser } from "$app/environment";
import { writable } from "svelte/store";
import {
	CHOICE_KEY,
	DEFAULT_MODE,
	KEY,
	ORDER,
	resolveInitialWebSearchMode,
	type WebSearchMode,
} from "./webSearchModeDefault";

// How should this session use open-web search? Three states, mirroring the read-aloud control's
// off/auto/always shape (see $lib/chat/stores/speakMode):
//   off    — Never search the web. The answer comes from training + community/RAG only, and an
//            "I can't be sure this is current" hedge is then CORRECT.
//   auto   — THE DEFAULT (CUR-2030). Check community/RAG first; the open web runs ONLY when community
//            is insufficient AND the per-turn margin gate says the turn needs current info, or when the
//            person pasted a link. Community first, web as a fallback.
//   always — the open web ALWAYS runs (honors an explicit user choice), in addition to community.
//            Skips the margin gate — the user asked for it.
//
// The community-first sequencing + the insufficiency fallback are decided SERVER-side (the chat
// handler runs RAG before deciding the web step — see conversation/[id]/+server.ts); this store just
// carries the user's per-device preference up with the turn. Lightweight client-only preference in
// localStorage, like the old boolean webSearchAllowed it replaces.
// Which stored keys mean what, and the default, live in webSearchModeDefault.ts (CUR-2030).
export type { WebSearchMode } from "./webSearchModeDefault";

function initial(): WebSearchMode {
	if (!browser) return DEFAULT_MODE;
	try {
		return resolveInitialWebSearchMode((k) => localStorage.getItem(k));
	} catch {
		return DEFAULT_MODE;
	}
}

export const webSearchMode = writable<WebSearchMode>(initial());

/** Next state in the off → auto → always → off cycle (for the composer's cycling control). */
export function nextWebSearchMode(m: WebSearchMode): WebSearchMode {
	return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

if (browser) {
	// Module-level, not component-scoped: this runs for the whole page session with nothing to key
	// an unmount off of (mirrors agentMode.ts/speakMode.ts's identical idiom). The unsubscribe this
	// rule wants captured would never be called anyway.
	// Bare disable (no rule name): this rule only exists in the main eslint config, which loads
	// eslint-plugin-svelte -- eslint.quality.config.js lints this same file WITHOUT that plugin, and
	// a disable comment naming an unregistered rule is a hard error there, not a no-op.
	// Subscribing calls back at once with the starting value. That one is not a choice, so it
	// isn't written: writing it would make a default indistinguishable from a choice.
	let first = true;
	// eslint-disable-next-line
	webSearchMode.subscribe((v) => {
		if (first) {
			first = false;
			return;
		}
		try {
			localStorage.setItem(CHOICE_KEY, v);
			localStorage.setItem(KEY, v);
		} catch {
			/* private mode / quota — preference just won't persist */
		}
	});
}

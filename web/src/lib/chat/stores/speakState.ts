import { writable } from "svelte/store";

// Per-turn voice UI state, set by the live send path and read by the trace footer.

// The message id whose answer is currently being synthesized to audio ("speak every answer" mode): the
// text is already on screen and we're in the ZeroGPU round-trip. The trace footer shows "Generating
// audio…" while this matches, instead of a silent pause. Cleared when the turn finishes.
export const synthesizingAudioFor = writable<string | null>(null);

// The current live phase of the in-flight turn ("screening" | "searching" | "thinking" | …), set from the
// `phase:<name>` markers the server emits as each phase genuinely starts. The live request-log reads this
// to show the active phase instead of a generic "working…". Cleared when the turn finishes.
export const currentPhase = writable<string | null>(null);

import { writable } from "svelte/store";

// Open-state for the "Stack X-Ray" panel. SSR-safe default is `false`; ChatWindow's onMount then
// opens it on DESKTOP (>=768px) so the live architecture is visible up front, before any turn has
// run — StackXRay.svelte renders all provenance products untouched in that pre-turn state, then
// reflects real per-turn facts once an answer lands.
export const stackOpen = writable<boolean>(false);

// Gates every entry point into the Stack X-Ray panel.
export const STACK_MAP_ENABLED = true;

// Kept for StackMap.svelte (dormant).
export const stackActiveCount = writable<number | null>(null);

// Which answer the XRAY panel describes. Undefined → the latest answer. Set by an answer's
// "How this was made" link together with `stackOpen`.
export const xrayMessageId = writable<string | undefined>(undefined);

// Set by an answer's Second opinion action: XRAY opens on Step by step, scrolled to the
// second-opinion offer at its foot, and clears it.
export const xraySecondOpinion = writable<boolean>(false);

import { writable } from "svelte/store";

// Open-state for the "Stack X-Ray" panel. SSR-safe default is `false`; ChatWindow's onMount then
// opens it on DESKTOP (>=768px) so the live architecture is visible up front, before any turn has
// run — StackXRay.svelte renders all provenance products untouched in that pre-turn state, then
// reflects real per-turn facts once an answer lands.
export const stackOpen = writable<boolean>(false);

// True while the mobile Stack X-Ray drawer is open — chat layout uses this to lock card scroll.
export const stackMobileOpen = writable<boolean>(false);

// Gates every entry point into the Stack X-Ray panel.
export const STACK_MAP_ENABLED = true;

// Gates the per-node "show on map ↗" links (SourceStrip, RagSourceStrip, VaultSynthesisNote,
// ProvenanceBadge, SafetyBadge). CAI-80: hidden for now (not removed — the flash-to-map behavior
// is meant to come back later), so keep the handlers/markup intact and just gate rendering here.
export const SHOW_ON_MAP_ENABLED = false;

// Kept for StackMap.svelte (dormant).
export const stackActiveCount = writable<number | null>(null);

// Which answer the XRAY panel describes. Undefined → the latest answer. Set by an answer's
// "How this was made" link together with `stackOpen`.
export const xrayMessageId = writable<string | undefined>(undefined);

// Set by an answer's Second opinion action (CUR-4187): XRAY opens on Step by step, scrolled to the
// second-opinion offer at its foot, and clears it.
export const xraySecondOpinion = writable<boolean>(false);

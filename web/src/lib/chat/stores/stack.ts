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

// Set by the same action to the answer whose second opinion it asks for: the click already says "get
// me a second opinion", so SecondOpinion.svelte on that answer starts the run once and clears it.
// Nothing else sets it, so opening XRAY any other way starts nothing, and closing XRAY drops a
// request no offer has taken yet.
export const secondOpinionStart = writable<string | undefined>(undefined);
// eslint-disable-next-line svelte/no-ignored-unsubscribe -- module-lifetime link between two app-wide stores
stackOpen.subscribe((open) => {
	if (!open) secondOpinionStart.set(undefined);
});

import { writable } from "svelte/store";

// Open-state for the single, top-level WeakSpotsModal — the honest "where this system is
// systematically weak" disclosure (recency, language skew, not-advice, can-be-wrong). Mounted
// ONCE at the ChatWindow root next to ContributeDialog so its Modal backdrop intro plays; the
// footer "weak spots" link (and any other surface) just flips this. `false` = closed.
export const weakSpotsOpen = writable<boolean>(false);

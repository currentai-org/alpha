import { writable } from "svelte/store";

// Open-state for the single, top-level ContributeDialog. The dialog is mounted ONCE at the
// ChatWindow root (not nested inside the welcome overlay), so its Modal's backdrop intro
// transition plays normally — nesting it inside the welcome overlay's stacking/inert subtree
// leaves the `fade` backdrop stuck at opacity 0 (whole modal rendered translucent). Any CTA
// (the welcome overlay's "How to contribute", a stack-map node's "Get involved") just flips
// this.
//
// `false` = closed; `true` = generic open; `{ topic }` = opened from a specific gap /
// open-invitation on the live-stack map — the dialog then opens in "Raise your hand" mode and
// names that gap.
// `node` is the stack-map node id (static/data/stack-map.json), carried through to the
// contribution_form_opened/submitted PostHog events as `node_id`, so a lead can be tied to a
// specific gap — optional because the generic `true` open has no gap.
export type ContributeState = boolean | { topic: string; node?: string };
export const contributeOpen = writable<ContributeState>(false);

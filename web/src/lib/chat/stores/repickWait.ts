import { writable } from "svelte/store";

/**
 * The answer Auto is waiting on for a first word, while its in-turn re-pick is on. The live
 * request log reads it to say the model is slow to start before the give-up asks another model. Set by
 * the conversation page when it sends, cleared when the turn ends.
 */
export const repickWait = writable<{ answerId: string; model: string; waitMs: number } | null>(null);

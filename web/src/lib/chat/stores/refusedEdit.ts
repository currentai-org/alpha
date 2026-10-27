import { writable } from "svelte/store";

/**
 * An edit the server refused before streaming (CUR-2825): which message was being edited, the text
 * the person wrote, and the server's reason. The conversation page sets it in place of putting the
 * text in the main composer; the chat window reopens that message's edit box from it, and the message
 * takes the text and reason and clears it.
 */
export type RefusedEdit = { id: string; text: string; reason: string };

export const refusedEdit = writable<RefusedEdit | null>(null);

import { writable } from "svelte/store";

/**
 * Counts presses of New chat (CUR-3052). On the empty composer New chat navigates nowhere, so the
 * landing page clears its attachments when this changes rather than on a route change.
 */
export const newChatRequests = writable(0);

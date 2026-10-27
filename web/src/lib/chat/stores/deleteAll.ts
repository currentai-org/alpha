import { writable } from "svelte/store";

// Open-state for the single, top-level DeleteAllConversationsModal ("forget everything" — a real
// GDPR-style wipe: conversations, settings, and usage records). Triggered from the chat header's
// "forget everything" button. Mounted ONCE in +layout.svelte (a store, not local component state,
// so it's reachable from ChatWindow — a sibling of NavMenu, not a descendant — without prop
// drilling through +layout.svelte).
export const deleteAllOpen = writable<boolean>(false);

// Which of the two actions the open modal performs (CUR-1420). "data" is "Forget everything": a
// signed-in person's data goes and their account stays. "account" is "Delete account" on the account
// page, which also removes the account and its sign-in methods. Every opener sets it, so a stale value
// from a previous opening can never turn a data wipe into an account deletion.
export const deleteAllMode = writable<"data" | "account">("data");

// True from the moment the wipe request goes out until the confirmation panel is dismissed.
//
// The wipe deletes the conversation the visitor is currently reading, so every background re-fetch
// of that conversation is guaranteed to 404 from here on — and a 404 there redirects to the chat
// entry (conversation/[id]/+page.ts), which on this deployment is a cross-tree navigation that
// destroys the confirmation panel before it has been read. `deleteAllConversations()` already
// defers its OWN navigation for exactly that reason; this covers the navigations that arrive from
// somewhere else. The live case is a turn still streaming when the visitor hits "forget
// everything": its post-turn resync fires seconds later against a row that is deliberately gone
// (CUR-1642).
//
// Read it wherever a conversation refresh is about to run. By the time the load reaches its catch
// block the request has already been spent, so the redirect there is too late a place to guard.
export const wipeInProgress = writable<boolean>(false);

// The trigger button the wipe confirmation drops down from, so the modal renders attached to the
// "forget everything" button (per the Alpha mockup) rather than free-floating. Set by whichever
// SessionFootprint instance (desktop header / mobile compact) opened it; cleared on close.
export const deleteAllAnchor = writable<HTMLElement | undefined>(undefined);

// True once the wipe has committed on the server, until the visitor dismisses the receipt and the
// navigation home has finished. The conversation page renders no messages while it is set, because
// the transcript behind the receipt has just been deleted: leaving it up would show the deleted prompt
// and its interrupted answer under "Your data has been cleared", and again for a beat after Done
// while the navigation home loads (CUR-1924). Raised only on success, so a failed wipe leaves the
// conversation, which still exists, on screen.
export const wipeCommitted = writable<boolean>(false);

// Set once a wipe has run in this page session. The wipe deletes settings too, including the mark that
// the welcome was seen, so the reset home would render the empty chat and then, once the reloaded settings
// arrive, the welcome splash over it: empty chat, splash, empty chat (CUR-2270). The person has just
// used the app, so the splash stays down for the rest of this page session. Nothing is written back to
// the server, so a reload or a later visit still gets the welcome, as a visitor whose data was forgotten
// should.
export const wipedThisSession = writable<boolean>(false);

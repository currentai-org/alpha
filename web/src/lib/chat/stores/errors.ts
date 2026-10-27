import { writable } from "svelte/store";

export const ERROR_MESSAGES = {
	default: "Oops, something went wrong.",
	authOnly: "You have to be logged in.",
	rateLimited: "You are sending too many messages. Try again later.",
	connectionLost: "The connection dropped before a reply arrived. Please try again.",
	// The visitor's own connection failed after part of the answer arrived. (CUR-2805)
	connectionDroppedMidAnswer:
		"Your connection dropped before this answer finished. Please try again.",
	// A 503 capacity shed the server retried on our behalf but couldn't clear. Not a connection loss
	// or the user's fault: the service is briefly saturated. Distinct copy so the user isn't told to
	// check a connection that's fine.
	atCapacity: "AI Potluck is busy right now. Please try again in a moment.",
	// A conversation link from before signing in (or from a different session/browser). Distinct from
	// "not found" because nothing is broken; the link belongs to another session.
	conversationUnavailable: "That conversation isn't available in this session.",
	// A server error or dropped connection while opening a chat; nothing is known about the chat.
	conversationCouldNotOpen: "That conversation couldn't be opened right now. Reload the page to try again.",
	// The sign-out request was refused or never arrived, so the session is still live.
	signOutRefused: "Log out didn't go through, so you're still signed in. Choose Log out again.",
};

export const error = writable<string | undefined>(undefined);

/** Set alongside `error` when the server refused a send before it started streaming (a 4xx such as
 *  "Message too long."). The unsent text is back in the composer and the reason is what the person has
 *  to act on, so the toast is held like a rate-limit stop instead of flashing for five seconds, and the
 *  next send clears it (CUR-1896). */
export const errorHeld = writable(false);

/** Is this error string one of the server's rate-limit / cap 429 messages (per-session, global daily,
 *  or per-conversation)? Used to give those a longer-lived toast and to preserve the unsent text, so a
 *  hard stop is never a 5-second flash that silently eats the message. */
export const isRateLimitMessage = (message: string | undefined): boolean =>
	/too many messages|request limit|more than \d+ messages/i.test(message ?? "");

/** When the server refused a send for our own message limit and said how long the window has left:
 *  the moment (epoch ms) a send can pass again. The composer holds Send and counts down until then,
 *  since every press inside the window is recorded and pushes it further out (CUR-3216). */
export const sendHeldUntil = writable<number | undefined>(undefined);

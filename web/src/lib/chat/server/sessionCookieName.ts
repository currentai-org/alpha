import { config } from "$lib/chat/server/config";

// Session cookie name. Unlike secure/sameSite, config has no default for COOKIE_NAME (it's a plain
// env passthrough), so when the env var is unset — e.g. on a deploy that didn't set it — config.COOKIE_NAME
// is "", and cookies.set("", …) makes cookie.serialize throw "argument name is invalid", 500-ing every
// cookie-setting POST (conversation create, settings). Default to the chat-ui heritage name so the cookie
// always has a valid name. Used for both set and read so they can't drift. Its own module so the guest
// handoff page reads it without loading auth.ts (guestHandoffPage.ts).
export const sessionCookieName = config.COOKIE_NAME || "hf-chat";

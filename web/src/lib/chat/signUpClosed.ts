// Shared by the server's refusal (server/selfHostSignUp.ts) and the sign-in page that shows it
// (routes/chat/login/+page.svelte), so the two say the same thing.

/** The error code Better Auth's sign-up route answers with once password sign-up has closed. */
export const SIGN_UP_CLOSED_CODE = "SIGN_UP_CLOSED";

export const SIGN_UP_CLOSED_MESSAGE =
	"Sign-up is closed on this server. Ask the person who runs it to create an account for you.";

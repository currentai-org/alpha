// The oauth-provider plugin's `loginPage` (betterAuth.ts). Sends a signed-out visitor to
// Alpha's own sign-in with the authorize request to resume afterwards, or, when they are signed in
// already, straight back to it. (CUR-4312)
import { redirect, type RequestHandler } from "@sveltejs/kit";
import { authorizeResumePath, signInForAuthorize } from "$lib/chat/server/sync/authorizeResume";

export const GET: RequestHandler = ({ url, locals }) => {
	redirect(302, locals.user ? authorizeResumePath(url.searchParams) : signInForAuthorize(url.searchParams));
};

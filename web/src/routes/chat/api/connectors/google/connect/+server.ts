import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { logger } from "$lib/chat/server/logger";
import {
	GOOGLE_CONNECT_COOKIE,
	GOOGLE_CONNECT_COOKIE_PATH,
	googleConnectApp,
	googleConnectorEnabled,
	googleFaultDeps,
	startConnect,
} from "$lib/chat/server/connectors/google";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { CONNECT_TTL_SECONDS, sealConnectState } from "$lib/chat/server/storage/locations/connectState";
import { credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";

// The Connect Google button in Settings → Connectors lands here. It mints a state and a PKCE verifier,
// seals both with the account id into a short-lived cookie, and sends the browser to Google's consent.
export const GET: RequestHandler = async ({ locals, cookies, url, request }) => {
	if (!googleConnectorEnabled()) error(404, "Not found");
	const accountId = locals.user?._id?.toString();
	if (!accountId) error(401, "Sign in to connect your Google account.");
	const app = googleConnectApp();
	if (!app) {
		logger.error("[google-connector] Connect Google is on but its client or connector is not configured");
		error(503, "Connecting Google isn't set up on this server.");
	}
	const { url: consent, state, verifier } = await startConnect(app, googleFaultDeps(await resolveFaultInjection(request)));
	cookies.set(GOOGLE_CONNECT_COOKIE, sealConnectState({ state, verifier, accountId }, credentialSecret()), {
		path: GOOGLE_CONNECT_COOKIE_PATH,
		httpOnly: true,
		// Plain http on a local install would never send a Secure cookie back.
		secure: url.protocol === "https:",
		// Lax, so the cookie rides the top-level redirect back from accounts.google.com.
		sameSite: "lax",
		maxAge: CONNECT_TTL_SECONDS,
	});
	// consent.href is on Google (or, under the e2e fault, its stand-in): SvelteKit 3 refuses an off-origin
	// redirect without this.
	redirect(303, consent.href, { external: true });
};

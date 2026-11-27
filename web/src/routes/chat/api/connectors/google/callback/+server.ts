import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import {
	finishConnect,
	forgetAccessToken,
	GOOGLE_CONNECT_COOKIE,
	GOOGLE_CONNECT_COOKIE_PATH,
	GoogleConnectError,
	googleConnectApp,
	googleConnectorEnabled,
	googleFaultDeps,
	sealRefreshToken,
} from "$lib/chat/server/connectors/google";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { saveUserGoogleConnection } from "$lib/chat/server/db/userGoogleConnections";
import { checkConnectState } from "$lib/chat/server/storage/locations/connectState";
import { credentialSecret } from "$lib/chat/server/storage/locations/sealedSecret";

const CONNECTORS = `${base}/settings/connectors`;

function back(outcome: "connected" | "denied" | "scopes" | "failed"): never {
	redirect(303, outcome === "connected" ? `${CONNECTORS}?google=connected` : `${CONNECTORS}?google_error=${outcome}`);
}

// Google sends the browser back here after its consent screen. Check the sealed state against the
// account, trade the code for tokens, seal the refresh token for this account, and go back to Connectors,
// which reads `google` or `google_error` and says what happened.
export const GET: RequestHandler = async ({ locals, cookies, url, request }) => {
	if (!googleConnectorEnabled()) error(404, "Not found");
	const accountId = locals.user?._id?.toString();
	if (!accountId) error(401, "Sign in to connect your Google account.");
	const sealed = cookies.get(GOOGLE_CONNECT_COOKIE);
	cookies.delete(GOOGLE_CONNECT_COOKIE, { path: GOOGLE_CONNECT_COOKIE_PATH });
	// The person pressed Cancel on Google's screen.
	if (url.searchParams.get("error") === "access_denied") back("denied");
	const checked = checkConnectState(sealed, url.searchParams.get("state"), accountId, credentialSecret());
	if (!checked.ok) {
		logger.warn({ leg: "google-connector", reason: checked.reason }, "[google-connector] callback refused");
		back("failed");
	}
	const app = googleConnectApp();
	if (!app) error(503, "Connecting Google isn't set up on this server.");
	let grant: Awaited<ReturnType<typeof finishConnect>>;
	try {
		grant = await finishConnect(
			app,
			url,
			{ state: url.searchParams.get("state") ?? "", verifier: checked.verifier },
			googleFaultDeps(await resolveFaultInjection(request))
		);
	} catch (e) {
		if (e instanceof GoogleConnectError && e.reason === "missing-scope") back("scopes");
		logger.warn(
			{ leg: "google-connector", err: e instanceof Error ? e.message : String(e) },
			"[google-connector] the code exchange failed"
		);
		back("failed");
	}
	await saveUserGoogleConnection({
		userId: accountId,
		email: grant.email,
		scopes: grant.scopes,
		credential: sealRefreshToken(grant.refreshToken),
	});
	forgetAccessToken(accountId);
	logger.info({ leg: "google-connector" }, "[google-connector] an account connected Google");
	back("connected");
};

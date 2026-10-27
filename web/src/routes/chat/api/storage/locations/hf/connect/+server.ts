import { error, redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, CONNECT_TTL_SECONDS, sealConnectState } from "$lib/chat/server/storage/locations/connectState";
import {
	authorizeUrl,
	bucketNameOk,
	newState,
	pkcePair,
	storageOAuthApp,
} from "$lib/chat/server/storage/locations/hfOAuth";
import { credentialSecret } from "$lib/chat/server/storage/locations/registry";

import { requireLocationsAccess } from "../../../guard";

// The Connect Hugging Face button lands here. It mints a state and a PKCE pair, seals both
// with the account id into a short-lived cookie, and sends the browser to the storage app's consent.
// `?bucket=<name>` names the bucket to make; without it Alpha makes alpha-files. Connecting again with
// another name adds a second bucket. (CUR-2932)
export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const accountId = await requireLocationsAccess(locals);
	const bucket = url.searchParams.get("bucket")?.trim() || undefined;
	if (bucket && !bucketNameOk(bucket)) {
		// Back to the form with the name still in it, so the person can fix it there.
		redirect(303, `${base}/settings/storage?connect_error=name&bucket=${encodeURIComponent(bucket)}`);
	}
	const app = storageOAuthApp();
	if (!app) {
		// The flag is on for this account and the app is not configured: a misconfiguration, said loudly.
		logger.error("[storage-locations] Connect Hugging Face is on but HF_STORAGE_OAUTH_CLIENT_ID/SECRET is unset");
		error(503, "Connecting Hugging Face isn't available right now.");
	}
	const state = newState();
	const { verifier, challenge } = pkcePair();
	cookies.set(CONNECT_COOKIE, sealConnectState({ state, verifier, accountId, bucket }, credentialSecret()), {
		path: CONNECT_COOKIE_PATH,
		httpOnly: true,
		secure: true,
		// Lax, so the cookie rides the top-level redirect back from huggingface.co.
		sameSite: "lax",
		maxAge: CONNECT_TTL_SECONDS,
	});
	redirect(303, authorizeUrl(app, state, challenge));
};

import { redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import {
	createStorageLocation,
	listStorageLocations,
	setStorageLocationCredential,
	setStorageLocationStatus,
} from "$lib/chat/server/db/storageLocations";
import { checkConnectState, CONNECT_COOKIE, CONNECT_COOKIE_PATH } from "$lib/chat/server/storage/locations/connectState";
import {
	ALPHA_BUCKET_NAME,
	BucketScopeError,
	BucketTakenError,
	exchangeCode,
	grantUsername,
	OAuthGrantError,
	provisionAlphaBucket,
	sameRepo,
	serializeGrant,
	storageOAuthApp,
} from "$lib/chat/server/storage/locations/hfOAuth";
import { credentialSecret } from "$lib/chat/server/storage/locations/registry";
import { seal } from "$lib/chat/server/storage/locations/sealedSecret";
import { MAX_LINKED_LOCATIONS } from "$lib/chat/server/storage/locations/types";

import { requireLocationsAccess } from "../../../guard";

// Hugging Face sends the browser back here after the consent screen. Check the sealed state,
// trade the code for a grant, make sure the grant can create and open `<user>/alpha-files` (or the
// bucket the person named on Connect), then store
// it as a location. Every outcome redirects to Storage settings, which reads `connected` or
// `connect_error` and says what happened. (CUR-2932)

const SETTINGS = `${base}/settings/storage`;

// `refreshed` names the bucket that was already linked, so the page can say nothing new was added.
// `connected` carries the new location's id, so the page can offer to save and move files there
// (CUR-2941).
// `taken` carries the name, so the form comes back holding it.
function back(
	outcome: { connected: string } | { refreshed: string } | { error: string; bucket?: string }
): never {
	const q =
		"connected" in outcome
			? `connected=1&location=${encodeURIComponent(outcome.connected)}`
			: "refreshed" in outcome
				? `connected=refreshed&bucket=${encodeURIComponent(outcome.refreshed)}`
				: `connect_error=${encodeURIComponent(outcome.error)}` +
					(outcome.bucket ? `&bucket=${encodeURIComponent(outcome.bucket)}` : "");
	redirect(303, `${SETTINGS}?${q}`);
}

export const GET: RequestHandler = async ({ locals, cookies, url }) => {
	const accountId = await requireLocationsAccess(locals);
	const sealed = cookies.get(CONNECT_COOKIE);
	cookies.delete(CONNECT_COOKIE, { path: CONNECT_COOKIE_PATH });

	const checked = checkConnectState(sealed, url.searchParams.get("state"), accountId, credentialSecret());
	if (!checked.ok) {
		logger.warn({ reason: checked.reason }, "[storage-locations] refused a Hugging Face connect callback");
		back({ error: "state" });
	}
	// The person pressed Deny, or Hugging Face refused the request itself.
	if (url.searchParams.get("error")) back({ error: "denied" });
	const code = url.searchParams.get("code");
	const app = storageOAuthApp();
	if (!code || !app) back({ error: "failed" });

	let repo: string;
	let username: string;
	let grantCredential: string;
	try {
		const grant = await exchangeCode(app, code, checked.verifier);
		username = await grantUsername(grant);
		repo = await provisionAlphaBucket(username, grant, undefined, checked.bucket);
		grantCredential = seal(serializeGrant(grant), credentialSecret());
	} catch (e) {
		if (e instanceof BucketTakenError) {
			logger.info({ err: e }, "[storage-locations] the bucket name is taken by a bucket Alpha did not make");
			back({ error: "taken", bucket: checked.bucket ?? ALPHA_BUCKET_NAME });
		}
		if (e instanceof BucketScopeError) {
			// The consent went through but the scope did not reach buckets.
			logger.warn({ err: e }, "[storage-locations] Hugging Face grant could not create or open a bucket");
			back({ error: "scope" });
		}
		logger.error({ err: e }, "[storage-locations] Hugging Face connect failed");
		back({ error: e instanceof OAuthGrantError ? "denied" : "failed" });
	}

	// Connecting again (after a revoke, or a second click) refreshes the existing location in place,
	// whatever case the name was typed in this time.
	const existing = await listStorageLocations(accountId);
	const same = existing.find((r) => sameRepo(r.config.repo, repo) && r.config.grant === "oauth");
	if (same) {
		await setStorageLocationCredential(accountId, same.id, grantCredential);
		await setStorageLocationStatus(accountId, same.id, "ok", null);
		back({ refreshed: same.config.repo });
	}
	if (existing.length >= MAX_LINKED_LOCATIONS) back({ error: "limit" });
	const created = await createStorageLocation({
		userId: accountId,
		kind: "hf-bucket",
		// A named bucket carries its name, so two of them in one account tell apart in the list.
		label:
			(checked.bucket ?? ALPHA_BUCKET_NAME) === ALPHA_BUCKET_NAME
				? `${username} on Hugging Face`
				: `${username}/${checked.bucket} on Hugging Face`,
		config: { repo, prefix: "", grant: "oauth" },
		credential: grantCredential,
	});
	back({ connected: created.id });
};

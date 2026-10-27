// The link `aipotluck-local-client` opens to pair a device in one click, the alternative to
// the settings page's Pair button plus copy and paste. The CLI makes up a random pairing id, opens
// `<origin>/chat/local-inference/pair?id=<pairing id>&name=<device name>`, and polls
// api/v2/local-inference/pairings/<pairing id> until it gets the install flags this page parks.
//
// Same gates as the settings page (settings/(nav)/local-inference/+page.server.ts), in the same order:
// the flags 404 before the sign-in redirect, so a deployment without the feature discloses nothing.
// Signed out, the visitor goes to sign-in with `next` set back to this exact URL, id and name included.
//
// Pairing on a GET is a CSRF hazard: anyone could put a link with an id they chose in front of a
// signed-in person, then collect the tunnel credentials for a device registered to that person's
// account, whose answers the person's chats would then be sent to. So the load pairs on its own only
// when the browser reports `Sec-Fetch-Site: none`, a navigation no web page started: a link opened
// from the CLI or another app, or a URL typed in. Every other arrival (a link on a page, the redirect
// back from sign-in, a browser that sends no such header) gets a confirm button naming the device,
// which posts to the action below behind SvelteKit's origin check. That keeps the common case one
// click without letting a web page pair a device for someone. A link opened from a desktop mail
// client also arrives as `none`; nothing in the browser can tell that apart from the CLI. (CUR-4110)
import type { Actions, PageServerLoad, RequestEvent } from "./$types";
import { error, fail, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { logger } from "$lib/chat/server/logger";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { managedInferenceEnabled, managedLocalInferenceEndpointsEnabled } from "$lib/chat/server/managedInferenceGate";
import { provisionManagedEndpoint } from "$lib/chat/server/managedInference/provision";
import { stubProvisioningDeps } from "$lib/chat/server/managedInference/e2eStub";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import {
	claimPairing,
	completePairing,
	isValidPairingId,
	pairingStatusFor,
	releasePairing,
} from "$lib/chat/server/db/localInferencePairings";
import { labelFromLink, type PairingOutcome } from "$lib/chat/server/managedInference/pairingLink";

function gate(event: RequestEvent): string {
	if (!localInferenceEndpointsEnabled() || !managedLocalInferenceEndpointsEnabled()) {
		error(404, "Not found");
	}
	if (!event.locals.user) {
		const next = event.url.pathname + event.url.search;
		redirect(302, `${base}/login?next=${encodeURIComponent(next)}`);
	}
	return event.locals.user._id.toString();
}

async function pair(event: RequestEvent, userId: string, pairingId: string, label: string): Promise<PairingOutcome> {
	// The fault swaps Pangolin for an in-process stub, so it also stands in for Pangolin's config.
	const stub = (await resolveFaultInjection(event.request)) === "pangolin_stub";
	if (!stub && !managedInferenceEnabled()) return { state: "unavailable" };

	const claim = await claimPairing(userId, pairingId);
	if (claim.status === "taken") return { state: "taken" };
	if (claim.status === "already-claimed") return { state: claim.completed ? "paired" : "pending", label };

	try {
		const { row, installArgs } = await provisionManagedEndpoint(
			{ userId, label },
			...(stub ? [stubProvisioningDeps] : [])
		);
		await completePairing(userId, pairingId, { endpointId: row.id, label: row.label, installArgs });
		return { state: "paired", label: row.label };
	} catch (err) {
		// Give the id back so the same link can be retried once whatever failed is fixed.
		await releasePairing(userId, pairingId);
		logger.error(
			{ err: err instanceof Error ? err.message : String(err) },
			"[managedInference] pairing link failed to provision"
		);
		return { state: "failed" };
	}
}

export const load: PageServerLoad = async (event): Promise<PairingOutcome> => {
	const userId = gate(event);
	const pairingId = event.url.searchParams.get("id") ?? "";
	if (!isValidPairingId(pairingId)) return { state: "invalid" };
	const label = labelFromLink(event.url.searchParams.get("name"));

	// A pairing this person already holds reports where it stands, however the request arrived: the
	// page's own data reloads (hydration, an invalidation, Back) come same-origin, and a finished
	// pairing must not turn back into a confirm button. Only an unclaimed id needs the check below.
	const status = await pairingStatusFor(userId, pairingId);
	if (status === "taken") return { state: "taken" };
	if (status === "completed") return { state: "paired", label };
	if (status === "pending") return { state: "pending", label };

	if (event.request.headers.get("sec-fetch-site") !== "none") return { state: "confirm", label };
	return pair(event, userId, pairingId, label);
};

export const actions: Actions = {
	default: async (event) => {
		const userId = gate(event);
		const pairingId = event.url.searchParams.get("id") ?? "";
		if (!isValidPairingId(pairingId)) return fail(400, { state: "invalid" } satisfies PairingOutcome);
		return pair(event, userId, pairingId, labelFromLink(event.url.searchParams.get("name")));
	},
};

/**
 * The CLI's poll for a pairing it started. `aipotluck-local-client` opens the pairing link
 * (routes/chat/local-inference/pair) with a random id it made up, then GETs this route with the same
 * id until the person's visit has provisioned a managed endpoint. Until then the answer is `{}`; the
 * first answer after carries the endpoint and its install flags, and every answer after that is `{}`
 * again, because collectPairing() clears them in the same transaction that reads them.
 *
 * No session: the CLI has none. The pairing id is the credential, which is why it must be 32-128
 * URL-safe characters (192 bits at the minimum) and why an unknown, pending, collected or expired id
 * all answer the same `{}`. Plain JSON rather than superjson, since the reader is a Python CLI, and
 * `no-store` so nothing between the CLI and here keeps a copy of the one answer with the secret.
 *
 * Deliberately NOT gated on the local-inference flags. Both are account-scoped (flagKeys.ts), and this
 * caller is anonymous, so it would read the deployment-wide answer: with the feature staged to team
 * accounts only, every poll would 404 while the person's own pairing page worked. The flags already
 * gate the only thing that writes here (the pairing page), so with them off this can only answer `{}`. (CUR-4110)
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { discloseToOwner } from "$lib/chat/server/api/utils/noSecretFields";
import { collectPairing, isValidPairingId } from "$lib/chat/server/db/localInferencePairings";

const NO_STORE = { "Cache-Control": "no-store" };

export const GET: RequestHandler = async ({ params }) => {
	const pairingId = params.pairingId ?? "";
	if (!isValidPairingId(pairingId)) error(400, "Pairing id must be 32-128 URL-safe characters");

	const credentials = await collectPairing(pairingId);
	if (!credentials) return json({}, { headers: NO_STORE });

	return json(
		{
			id: credentials.endpointId,
			label: credentials.label,
			installArgs: {
				tunnelId: credentials.installArgs.tunnelId,
				// The caller holds the pairing id the owner's signed-in visit claimed, which is what makes it
				// the owner's device; this is the one response that carries the secret.
				tunnelSecret: discloseToOwner(credentials.installArgs.tunnelSecret),
				tunnelEndpoint: credentials.installArgs.tunnelEndpoint,
			},
		},
		{ headers: NO_STORE }
	);
};

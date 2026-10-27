/**
 * The pieces of the CLI pairing link (routes/chat/local-inference/pair) that are plain
 * functions and types, kept out of the route module because SvelteKit allows only its own exports
 * there. (CUR-4110)
 */
import { randomServerName } from "$lib/chat/utils/randomServerName";

/** What the page shows. `label` is the device name as it will appear in the person's server list. */
export type PairingOutcome =
	| { state: "confirm"; label: string }
	| { state: "paired"; label: string }
	/** Another load of the same link is still provisioning. */
	| { state: "pending"; label: string }
	| { state: "invalid" }
	/** Another account already used this link. */
	| { state: "taken" }
	| { state: "unavailable" }
	| { state: "failed" };

const MAX_LABEL_LENGTH = 100;

/** The device name from the link, as a server label: control and format characters dropped, runs of
 *  whitespace collapsed, capped at the settings form's own 100. A link with no usable name gets the
 *  same kind of friendly default the settings form pre-fills. */
export function labelFromLink(raw: string | null): string {
	const cleaned = (raw ?? "")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_LABEL_LENGTH)
		.trim();
	return cleaned || randomServerName();
}

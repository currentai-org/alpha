// Read-only share links. A share publishes a person's conversation to anyone holding the
// link, so the whole feature sits behind the `share-links` flag: the "Share chat" menu row, the share
// API, the Shared links list in Data & privacy, and the signed-out viewer at /r/<id>, which answers 404
// while the flag is off even for a link made while it was on.
//
// The viewer is signed out, so it reads the deployment snapshot: a team-only production condition
// would let team members make links nobody else can open. Stage it in production with
// `env = production`, not by email.
import { flagEnabledOr } from "./flags";

export const SHARE_LINKS_FLAG = "share-links";

export function shareLinksEnabled(): boolean {
	return flagEnabledOr(SHARE_LINKS_FLAG, () => false);
}

// The link in the invitation email. acceptInvitation (Better Auth's own organization route)
// requires a session whose email matches the invitation's — same signed-in-only gate as
// ../../../settings/(nav)/account/+page.server.ts, redirecting back here after sign-in so an invited
// person who isn't signed in yet lands right back on this invitation, not on some generic page.
//
// also gated, same as settings/(nav)/workspace/+page.server.ts — checked BEFORE the sign-in
// redirect. The underlying accept/reject calls already 404 through Better Auth's organization-route
// gate when the flag is off, but this page's shell rendered regardless, disclosing the feature
// exists. Missed.
//
// gated on workspaceOrgCreationEnabled specifically — this page is entirely about accepting
// an invitation, so it stays behind the org-creation flag although the personal workspace view is
// live for everyone signed in. Inviting anyone must be
// unreachable by URL, and a live accept-invite shell is exactly that disclosure.
import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { workspaceOrgCreationEnabled } from "$lib/chat/server/workspacesGate";

export const load: PageServerLoad = async (event) => {
	if (!workspaceOrgCreationEnabled()) {
		throw error(404, "Not found");
	}
	if (!event.locals.user) {
		const next = event.url.pathname + event.url.search;
		throw redirect(302, `${base}/login?next=${encodeURIComponent(next)}`);
	}
	return { invitationId: event.params.id };
};

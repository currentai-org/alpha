// Same signed-in-only gate as ../account/+page.server.ts, plus the deployment-wide
// localInferenceEndpointsEnabled() flag check ../workspace/+page.server.ts uses for workspacesEnabled()
// — checked BEFORE the sign-in redirect so this defends the route itself, not just the nav link
// that points at it ((nav)/+layout.svelte hides the link, but a visitor who already has the URL
// bypasses that entirely). A 404, not a login redirect: when the flag is off the feature doesn't
// exist for this deployment, which isn't an auth problem.
// (CUR-1194)
// managedLocalInferenceEndpointsEnabled() is a SEPARATE flag, not a 404 gate on this route
// — a deployment can have direct local-inference on and managed off (or vice versa), so it's
// returned as page data instead, same pattern as ../workspace/+page.server.ts's
// workspaceOrgCreationEnabled: gates a SECTION of an otherwise-reachable page, not the page itself.
// The return statement matters: a load() that does not return the flag leaves page.data's flag
// silently undefined, which is the pitfall that page's own header comment documents for
// page.data.workspaceOrgCreationEnabled. (CUR-1266)
import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { localInferenceEndpointsEnabled } from "$lib/chat/server/localEndpointsGate";
import { managedLocalInferenceEndpointsEnabled } from "$lib/chat/server/managedInferenceGate";

export const load: PageServerLoad = async (event) => {
	if (!localInferenceEndpointsEnabled()) {
		throw error(404, "Not found");
	}
	if (!event.locals.user) {
		const next = event.url.pathname + event.url.search;
		throw redirect(302, `${base}/login?next=${encodeURIComponent(next)}`);
	}

	return {
		managedInferenceEnabled: managedLocalInferenceEndpointsEnabled(),
	};
};

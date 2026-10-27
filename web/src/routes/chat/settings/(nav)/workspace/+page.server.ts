// Same signed-in-only gate as ../account/+page.server.ts: workspace membership is a Better Auth
// organization, so every call this page makes needs a real Better Auth session, not just any
// legacy sign-in shape.
//
// Also gated on workspacesEnabled(), checked BEFORE the sign-in redirect (CUR-913). This defends the
// route itself, not just the nav link that points at it (+layout.svelte hides the link, but a visitor
// who already has the URL bypasses that entirely). A 404, not a login redirect: when the flag is off
// the feature doesn't exist for this deployment, which isn't an auth problem.
//
// The load must return `workspaceOrgCreationEnabled`. +page.svelte and orgsState.ts's
// resolveOrganizationsState() branch on it, and loadOrganizations() treats a missing value exactly
// like "org creation off" (resolveOrganizationsState(false)) and skips authClient.organization.list()
// entirely, so every signed-in workspace member would see the bare zero-org personal-workspace
// fallback instead of their real workspace list/switcher/admin tools, whatever the live
// `workspace-org-creation` flag says.
import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { requireSignedInPage } from "$lib/chat/server/signedInPage";
import { workspacesEnabled, workspaceOrgCreationEnabled } from "$lib/chat/server/workspacesGate";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";

export const load: PageServerLoad = async (event) => {
	if (!workspacesEnabled()) {
		throw error(404, "Not found");
	}
	requireSignedInPage(event);

	// Workspaces the person has chats from but no longer belongs to, and which one the
	// conversation list is showing. (CUR-3040)
	const scope = await workspaceScopeFor(event.locals, event.request?.headers);
	return {
		workspaceOrgCreationEnabled: workspaceOrgCreationEnabled(),
		formerWorkspaces: scope?.former ?? [],
		viewingFormerId: scope?.viewingFormer?.id ?? null,
	};
};

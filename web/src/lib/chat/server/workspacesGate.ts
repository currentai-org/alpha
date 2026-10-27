import { flagEnabledOr } from "$lib/chat/server/flags";

// Gates the organizations/workspaces feature (CUR-913). Default-off fallback: a new,
// not-yet-trusted feature should fail closed if PostHog is ever unreachable, not fail open.
//
// Two privileges, two flags (CUR-957): seeing your own workspace and its settings (a personal-account
// concept, safe for anyone signed in) versus creating an additional workspace and inviting other people
// into it (an org-creation privilege granted to partners). The partner
// gate can then flip without also hiding the personal view every signed-in user should see.

/** PostHog flag key. Owner: chat. Gates the settings nav "Workspace" tab and page reachability. */
export const WORKSPACES_FLAG = "workspaces";

/** PostHog flag key. Owner: chat. Gates creating an additional workspace and inviting members into
 * one — the org-creation privilege, distinct from just seeing your own workspace. */
export const WORKSPACE_ORG_CREATION_FLAG = "workspace-org-creation";

/**
 * Is the workspace settings surface on for this deployment? Sync, never throws.
 *
 * Deployment-wide, not per-user — it gates the settings nav "Workspace" tab and the page itself
 * (routes/chat/settings/(nav)/workspace/+page.server.ts). Does NOT gate whether a second workspace
 * can be created or anyone invited — see workspaceOrgCreationEnabled for that, deliberately a
 * separate switch (CUR-957).
 */
export function workspacesEnabled(): boolean {
	return flagEnabledOr(WORKSPACES_FLAG, () => false);
}

/**
 * Is creating an additional workspace, or inviting anyone into one, on for this deployment? Sync,
 * never throws. Default-off fallback, same reasoning as workspacesEnabled: an ungated invite/create
 * surface should fail closed if PostHog is ever unreachable, not fail open into the one privilege
 * this flag exists specifically to withhold.
 *
 * Deployment-wide, not per-user — it gates both a UI surface (the "Create another workspace" and
 * "Invite by email" sections on the workspace settings page) and an API surface (better-auth's
 * organization plugin routes, see routes/chat/api/auth/[...all]), and those two must agree: a
 * per-user split would let the screen hide the option for someone who could still reach the routes
 * directly, or the reverse.
 */
export function workspaceOrgCreationEnabled(): boolean {
	return flagEnabledOr(WORKSPACE_ORG_CREATION_FLAG, () => false);
}

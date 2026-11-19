import { flagEnabledOr } from "$lib/chat/server/flags";

// Seeing your own workspace and its settings is a personal-account concept, on for everyone signed in;
// the `workspaces` flag that once gated it was retired once it was on everywhere. Creating an
// additional workspace and inviting other people into it is a separate privilege Current AI grants to
// partners after a conversation, and it keeps its own flag below.

/** PostHog flag key. Owner: chat. Gates creating an additional workspace and inviting members into
 * one — the org-creation privilege, distinct from just seeing your own workspace. */
export const WORKSPACE_ORG_CREATION_FLAG = "workspace-org-creation";

/**
 * Is creating an additional workspace, or inviting anyone into one, on for this deployment? Sync,
 * never throws. Default-off fallback: an ungated invite/create surface should fail closed if PostHog
 * is ever unreachable, not fail open into the one privilege this flag exists specifically to withhold.
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

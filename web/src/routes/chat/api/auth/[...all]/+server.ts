// Better Auth's own SvelteKit catch-all — self-contained, serves every /chat/api/auth/*
// request directly via auth.handler. Does not touch event.locals; the authenticateRequest bridge in
// server/auth.ts is what resolves a Better Auth session into the app's existing locals shape.
import { toSvelteKitHandler } from "better-auth/svelte-kit";
import { getAuth } from "$lib/chat/server/betterAuth";
import { workspaceOrgCreationEnabled } from "$lib/chat/server/workspacesGate";
import { ensureFlagsPolled } from "$lib/chat/server/flags";
import { error, type RequestEvent } from "@sveltejs/kit";

// getAuth() is a memoized lazy singleton (see betterAuth.ts) — cheap to call per request, and the only
// way to keep this route's own import from ever eagerly touching the DB.
// The organization plugin mounts every one of its routes under /organization/* (confirmed
// against the installed source — crud-org/crud-invites/crud-members/crud-team/crud-access-control all
// share this one prefix), which is what makes a single substring check a clean, precise gate — it
// can't accidentally catch sign-in/OTP/passkey/genericOAuth traffic, which must keep working even
// while org creation is off. A 404, not a 403: unlike sign-in (a stated "not yet" policy on a surface
// that will exist), the feature genuinely doesn't exist for this deployment while the flag is off.
//
// Gated on workspaceOrgCreationEnabled specifically — seeing your own
// workspace and its settings is a separate, safe-by-default privilege from creating an ADDITIONAL one
// or inviting other people into it. This route is entirely about the latter (every /organization/*
// call is create/invite/list/get-full/set-active/remove/delete, none of them "just show my own"), so
// it stays gated on the org-creation flag even while the settings page itself is reachable.
function organizationRouteBlocked(event: RequestEvent): boolean {
	return event.url.pathname.includes("/organization/") && !workspaceOrgCreationEnabled();
}

async function handler(event: RequestEvent) {
	// The org gate reads the flag snapshot synchronously, which answers OFF until this
	// instance has polled PostHog.
	await ensureFlagsPolled();
	if (organizationRouteBlocked(event)) {
		error(404, "Not found");
	}
	return toSvelteKitHandler(getAuth())(event);
}

export const GET = handler;
export const POST = handler;

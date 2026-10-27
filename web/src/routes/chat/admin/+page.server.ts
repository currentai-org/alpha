// Admin portal — a landing page linking a staff member to the admin panels (reports, RAG console,
// tuning). Shown to any account whose role may view the console (adminAuth.ts). The portal only renders
// links; each target enforces its own permission, so this page exposes nothing beyond the existence of
// the panels.

import type { PageServerLoad } from "./$types";
import { isAdminPermitted } from "$lib/chat/server/adminAuth";

// NO per-route `export const config` here — a per-route config splits the adapter-vercel build and
// drops the /chat base from route patterns. Rely on the 300s default.
export const load: PageServerLoad = async ({ locals, cookies }) => {
	return {
		needsLogin: !(await isAdminPermitted({ cookies, locals }, { console: "view" })),
		signedIn: Boolean(locals.user),
	};
};

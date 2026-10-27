// Trust & Safety panel — DELIBERATELY separate from the user-feedback Reports panel: this is for
// Coop moderation activity (turns the safety gate declined), not user-submitted bug/answer reports.
//
// Two surfaces (per the product decision): (1) a deep-link to Coop's own dashboard for the
// authoritative violation/strike records, and (2) — pending — a list of turns OUR app declined.
// (2) needs decline-event logging first: a decline currently only stamps message.moderation inside
// the conversation JSONB (not a queryable table), so the in-app declines list lands once that event
// log exists. For now this panel ships surface (1).
//
// Gated by the unified admin login like the other panels (redirect to the /admin portal when not
// signed in; the shared admin cookie authorizes this page).
import { isAdminPermitted } from "$lib/chat/server/adminAuth";
import { config } from "$lib/chat/server/config";
import { env } from "$env/dynamic/private";
import { listDeclines } from "$lib/chat/server/db/safetyEvents";
import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { reports: "read" }))) {
		redirect(303, `${base}/admin`);
	}
	// Only surface the Coop link if it's an http(s) URL — never let a misconfigured (or hostile)
	// COOP_DASHBOARD_URL become a javascript:/data: href the operator could click (XSS via config).
	const rawCoop = (config.COOP_DASHBOARD_URL || "").trim();
	return {
		coopDashboardUrl: /^https?:\/\//i.test(rawCoop) ? rawCoop : null,
		// Whether the in-app moderation gate is even configured (else "declined turns" is always empty
		// because everything is allowed through). COOP_URL/COOP_API_KEY are read from the environment,
		// matching $lib/chat/server/moderation.
		moderationConfigured: Boolean((env.COOP_URL || "").trim() && (env.COOP_API_KEY || "").trim()),
		declines: await listDeclines(),
	};
};

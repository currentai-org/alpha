// Admin reports dashboard — read-only view of the `reports` table (the ROOST triage seam fed by the
// per-answer report button AND the general "report a problem" channel). Gated on a role that may read
// reports (adminAuth.ts). The one
// mutation is a report's status (CUR-3903), which the reporter sees on their own reports page.

import { fail } from "@sveltejs/kit";
import type { PageServerLoad, Actions } from "./$types";
import { listReports, setReportStatus } from "$lib/chat/server/db/reports";
import { REPORT_STATUS_KEYS, type ReportStatus } from "$lib/chat/reportReasons";
import {
	adminActor,
	isAdminPermitted,
	requireAdminPermission,
} from "$lib/chat/server/adminAuth";
import { recordStaffContentRead } from "$lib/chat/server/staffContentRead";

// NO per-route `export const config` here — a per-route config splits the adapter-vercel build and
// drops the /chat base from route patterns. Rely on the 300s default.
export const load: PageServerLoad = async ({ locals, cookies, getClientAddress }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { reports: "read" }))) {
		// No reports:read role → the sign-in prompt only; never leak report data before auth. Typed empty list so the
		// PageData shape matches the authed branch.
		return {
			needsLogin: true,
			signedIn: Boolean(locals.user),
			reports: [] as Awaited<ReturnType<typeof listReports>>,
		};
	}
	const rows = await listReports();
	// The table shows each reported answer's text, so loading it is a read of those
	// conversations. The reason is the triage queue itself: every row is a report someone filed.
	// A report whose conversation was deleted keeps its answer text and has no conversation id, so it
	// is named by its report id instead. (CUR-4385)
	const conversationIds = [
		...new Set(rows.filter((r) => r.answerText).map((r) => r.conversationId ?? `report:${r.id}`)),
	];
	if (conversationIds.length > 0) {
		recordStaffContentRead({
			actor: await adminActor(cookies, locals),
			surface: "reports.list",
			conversationIds,
			reason: "reports triage queue",
			ip: getClientAddress(),
		});
	}
	return {
		needsLogin: false,
		signedIn: Boolean(locals.user),
		reports: rows,
	};
};

const isStatus = (v: string): v is ReportStatus => (REPORT_STATUS_KEYS as readonly string[]).includes(v);

export const actions: Actions = {

	/** Record what the team decided about one report; the reporter's own page shows it. */
	setStatus: async ({ request, cookies, locals }) => {
		await requireAdminPermission({ cookies, locals }, { reports: "read" });
		const fd = await request.formData();
		const id = String(fd.get("id") ?? "");
		const status = String(fd.get("status") ?? "");
		if (!id || !isStatus(status)) return fail(400, { statusError: "Pick a status for a report." });
		if (!(await setReportStatus(id, status))) return fail(404, { statusError: "That report no longer exists." });
		return { statusSet: id };
	},
};

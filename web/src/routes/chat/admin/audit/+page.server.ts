// Admin audit log view — recent admin-area actions, so config changes can be reconstructed and
// access reviewed. Read-only. Gated by the unified admin login like the other panels.
import { isAdminPermitted } from "$lib/chat/server/adminAuth";
import { listAuditLog } from "$lib/chat/server/db/adminAudit";
import { redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) {
		redirect(303, `${base}/admin`);
	}
	return { entries: await listAuditLog() };
};

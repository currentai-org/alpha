import { listOwnReports, type ReportOwner } from "$lib/chat/server/db/reports";
import type { PageServerLoad } from "./$types";

// Settings → Your reports (CUR-3903): the reports this visitor sent, with what staff decided about
// each, so a report doesn't vanish after the thank-you line. A guest is known by session only.
export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.user?._id?.toString();
	const owner: ReportOwner | null = userId
		? { userId }
		: locals.sessionId
			? { sessionId: locals.sessionId }
			: null;
	return { signedIn: Boolean(userId), reports: owner ? await listOwnReports(owner) : [] };
};

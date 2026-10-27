// Admin read-only transcript of a reported conversation. The user-feedback Reports table links here
// so a triager can READ the offending turn. We deliberately do NOT reuse /conversation/[id]: that
// route is auth-scoped (authCondition) to the OWNER's session, so an admin viewing a reporter's
// anonymous conversation 404s and bounces to the chat home. Here we look the
// conversation up by _id WITHOUT the session scope — gated instead by the unified admin login — and
// render it read-only. The view is audited (admin reading user content is a privacy-relevant action).
//
// Every read carries a reason. A conversation somebody reported cites its report ids; any
// other conversation shows nothing until the staff member types why, and the read is then recorded
// in admin_audit and in the Axiom security dataset, which database access cannot alter. (CUR-4385)
import { isAdminPermitted, adminActor } from "$lib/chat/server/adminAuth";
import { collections } from "$lib/chat/server/database";
import { reportIdsForConversation } from "$lib/chat/server/db/reports";
import { acceptableReason, recordStaffContentRead } from "$lib/chat/server/staffContentRead";
import { convertLegacyConversation } from "$lib/chat/utils/tree/convertLegacyConversation";
import { ObjectId } from "bson";
import { error, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ params, url, locals, cookies, getClientAddress }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { reports: "read" }))) {
		redirect(303, `${base}/admin`);
	}

	let _id: ObjectId;
	try {
		_id = new ObjectId(params.conversationId);
	} catch {
		error(400, "Invalid conversation ID.");
	}

	// Admin-scope read: NO authCondition — triage must see conversations the admin doesn't own. Loaded
	// before the reason check so a missing one still answers 404; nothing of it is returned until a
	// reason is on record.
	const conv = await collections.conversations.findOne({ _id });
	if (!conv) {
		error(404, "Conversation not found (it may have been deleted by the user).");
	}

	const reportIds = await reportIdsForConversation(params.conversationId);
	const typedReason = acceptableReason(url.searchParams.get("reason"));
	if (reportIds.length === 0 && !typedReason) {
		// No report to cite and no reason given: show the reason field, never the content.
		return {
			needsReason: true as const,
			conversationId: params.conversationId,
			reasonTried: url.searchParams.has("reason"),
			messageId: url.searchParams.get("messageId"),
		};
	}
	const reason = [reportIds.length ? `report ${reportIds.join(", ")}` : null, typedReason]
		.filter(Boolean)
		.join("; ");

	const focusMessageId = url.searchParams.get("messageId") || null;

	// Audit the read (actor, conversation, reason, hashed IP; never the conversation content).
	recordStaffContentRead({
		actor: await adminActor(cookies, locals),
		surface: "report.view",
		conversationIds: [params.conversationId],
		reason: focusMessageId ? `${reason}; message ${focusMessageId.slice(0, 12)}` : reason,
		ip: getClientAddress(),
	});

	const normalized = { ...conv, ...convertLegacyConversation(conv) };

	return {
		needsReason: false as const,
		conversationId: params.conversationId,
		reason,
		title: normalized.title ?? "(untitled conversation)",
		createdAt: normalized.createdAt ?? null,
		focusMessageId,
		// Read-only projection: only what the transcript needs (role + text + id). No system internals.
		messages: (normalized.messages ?? []).map((m) => ({
			id: m.id,
			from: m.from,
			content: m.content ?? "",
		})),
	};
};

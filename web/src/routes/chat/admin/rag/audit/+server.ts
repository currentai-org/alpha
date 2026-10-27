// Admin audit view (Phase 3): the immutable rag_document_audit trail for one document.
// Session-admin-gated GET ?id=<documentId>.

import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";
import { getRagDocumentAudit } from "$lib/chat/server/rag/adminWrites";

export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { console: "view" });
	const id = (url.searchParams.get("id") || "").trim();
	if (!id) throw error(400, "id is required.");
	try {
		return json({ audit: await getRagDocumentAudit(id) });
	} catch (e) {
		throw error(500, e instanceof Error ? e.message : "Failed to load audit.");
	}
};

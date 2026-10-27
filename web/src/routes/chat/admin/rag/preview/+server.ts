// Live preview for the admin RAG console: rank a test query against the active admin chunks exactly
// as a turn would (previewAdminQuery), so an editor can see what a query retrieves and at what
// scores BEFORE relying on it. Gated by requireAdminPermission (console:view), never RAG_ADMIN_ENABLED —
// previewing is how an admin validates content before turning the feature on.

import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";
import { previewAdminQuery } from "$lib/chat/server/rag/adminStore";

const schema = z.object({ query: z.string().min(1).max(2000) });

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { console: "view" });
	let body: z.infer<typeof schema>;
	try {
		body = schema.parse(await request.json());
	} catch {
		throw error(400, "A non-empty query is required.");
	}
	try {
		return json(await previewAdminQuery(body.query.trim()));
	} catch (e) {
		throw error(500, e instanceof Error ? e.message : "Preview failed.");
	}
};

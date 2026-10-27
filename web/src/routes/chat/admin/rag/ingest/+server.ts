// Admin ingest-from-url (Phase 3): fetch + extract reviewable text to pre-fill the create form.
// Session-admin-gated; uses ssrfSafeFetch under the hood (see adminIngest.ts), never the public
// /api/fetch-url. Returns { title, text, url } for the admin to review/edit before saving.

import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { z } from "zod";
import { requireAdminPermission } from "$lib/chat/server/adminAuth";
import { ingestUrl, RagIngestError } from "$lib/chat/server/rag/adminIngest";

const schema = z.object({ url: z.string().url().max(2000) });

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	await requireAdminPermission({ cookies, locals }, { rag: "write" });
	let body: z.infer<typeof schema>;
	try {
		body = schema.parse(await request.json());
	} catch {
		throw error(400, "A valid URL is required.");
	}
	try {
		return json(await ingestUrl(body.url));
	} catch (e) {
		if (e instanceof RagIngestError) throw error(400, e.message);
		throw error(502, "Failed to ingest the URL.");
	}
};

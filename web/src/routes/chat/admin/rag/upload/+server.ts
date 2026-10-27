// Admin file upload → DRAFT. One file per POST (multipart) so each upload gets its own XHR progress
// stream client-side and its own draft server-side. The file is sniffed + size-validated, parsed to
// text (extractFile) or captioned (captionImage for images), then landed as an INACTIVE draft via the
// existing createRagDocument — same chunk/embed/audit path and the same draft→activate approval gate
// as the manual create form. Nothing is ever auto-activated. Gated by requireAdminPermission (rag:write).

import type { RequestHandler } from "./$types";
import { error } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { requireAdminPermission, adminActor } from "$lib/chat/server/adminAuth";
import { logAdminActionSafe } from "$lib/chat/server/db/adminAudit";
import {
	resolveUploadKind,
	extractTextFromUpload,
	RagExtractError,
} from "$lib/chat/server/rag/extractFile";
import { captionImage, RagCaptionError } from "$lib/chat/server/rag/captionImage";
import { createRagDocument, RagWriteError } from "$lib/chat/server/rag/adminWrites";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_BYTES_ANY } from "$lib/chat/constants/ragUpload";

/** FK-safe actor id for createdBy/audit: a real user id or null (password login has no user row). */
function actorId(locals: App.Locals): string | null {
	return locals.user?._id?.toString() ?? null;
}

/** Today as YYYY-MM-DD — the default sourceDate when the admin doesn't supply one. */
function todayIso(): string {
	return new Date().toISOString().slice(0, 10);
}

// NO per-route `export const config` here. A per-route config makes adapter-vercel SPLIT the build
// into separate serverless functions, and in split mode the generated config.json route patterns
// LOSE the base path (/chat) — so every /chat/* request falls through to the catchall (which no
// longer contains the split routes) and 500s ("Page /chat/... not found"). That takes every /chat route down. The platform default timeout (now 300s) is ample for batched embeds, so rely on it.
export const POST: RequestHandler = async ({ request, locals, cookies, getClientAddress }) => {
	await requireAdminPermission({ cookies, locals }, { rag: "write" });

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		throw error(400, "Expected a multipart file upload.");
	}

	// getAll (not Object.fromEntries, which collapses duplicate keys); take the first File present.
	const file = form.getAll("files").find((f): f is File => f instanceof File);
	if (!file) throw error(400, "No file was provided.");

	const source = String(form.get("source") ?? "").trim();
	const sourceDate = String(form.get("sourceDate") ?? "").trim();
	const sourceType = String(form.get("sourceType") ?? "").trim();

	const bytes = new Uint8Array(await file.arrayBuffer());
	if (bytes.byteLength === 0) throw error(400, "That file is empty.");
	if (bytes.byteLength > UPLOAD_MAX_BYTES_ANY) throw error(413, "That file is too large.");

	const kind = await resolveUploadKind({ bytes, name: file.name, declaredMime: file.type });
	if (!kind) throw error(415, "Unsupported file type.");
	// Per-kind cap for EVERY kind (the image path skips extractTextFromUpload's internal check).
	if (bytes.byteLength > UPLOAD_MAX_BYTES[kind]) {
		throw error(413, `That ${kind} file is too large.`);
	}

	try {
		const extracted =
			kind === "image"
				? {
						...(await captionImage({ bytes, name: file.name, declaredMime: file.type })),
						sourceType: "image" as const,
					}
				: await extractTextFromUpload({ bytes, name: file.name, kind });

		const { doc, duplicateChunkCount } = await createRagDocument(
			{
				title: extracted.title,
				text: extracted.text,
				source: source || file.name,
				sourceType: sourceType || extracted.sourceType,
				url: null,
				sourceDate: sourceDate || todayIso(),
			},
			actorId(locals)
		);

		logAdminActionSafe({
			actor: await adminActor(cookies, locals),
			action: "rag.upload",
			target: doc.id,
			summary: `uploaded ${kind}: ${extracted.title.slice(0, 80)}`,
			ip: getClientAddress(),
		});

		return json({
			id: doc.id,
			title: doc.title,
			sourceType: extracted.sourceType,
			chars: extracted.text.length,
			duplicateChunkCount,
		});
	} catch (e) {
		// Parse/caption problems are the user's to fix (bad file) → 422; embed/cap failures → 400.
		if (e instanceof RagExtractError || e instanceof RagCaptionError) {
			throw error(422, e.message);
		}
		if (e instanceof RagWriteError) {
			throw error(400, e.message);
		}
		throw error(500, e instanceof Error ? e.message : "Upload failed.");
	}
};

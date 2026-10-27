// Admin RAG upload console, gated on the signed-in account's role (adminAuth.ts). A role holder
// (CUR-3990) needs console:view for the load and preview/audit, and rag:write for every mutation and
// upload. Mutations are SvelteKit form actions with optimistic-concurrency tokens; preview/upload are
// fetch endpoints.

import type { PageServerLoad, Actions } from "./$types";
import { fail } from "@sveltejs/kit";
import {
	listRagDocuments,
	createRagDocument,
	updateRagDocument,
	activateRagDocument,
	retireRagDocument,
	reembedRagDocument,
	RagConflictError,
	RagNotFoundError,
	RagWriteError,
} from "$lib/chat/server/rag/adminWrites";
import { ragAdminEnabled } from "$lib/chat/server/rag/env";
import { listLocalCatalog } from "$lib/chat/server/rag/localStore";
import {
	isAdminPermitted,
	requireAdminPermission,
	adminActor,
} from "$lib/chat/server/adminAuth";
import { logAdminActionSafe } from "$lib/chat/server/db/adminAudit";
import type { Cookies } from "@sveltejs/kit";

// NO per-route `export const config` here — see the long note in tuning/rag/upload/+server.ts: a
// per-route config splits the adapter-vercel build, which drops the /chat base path from the route
// patterns and 500s every /chat/* route. Rely on the 300s platform default.
export const load: PageServerLoad = async ({ locals, cookies }) => {
	if (!(await isAdminPermitted({ cookies, locals }, { console: "view" }))) {
		// Not signed in → render the login form (no data leaks before auth). Typed empty values so the
		// PageData shape matches the authed branch (avoids a never[] union for data.documents/catalog).
		return {
			needsLogin: true,
			signedIn: Boolean(locals.user),
			documents: [] as Awaited<ReturnType<typeof listRagDocuments>>,
			adminEnabled: ragAdminEnabled(),
			catalog: { model: "", dim: 0, builtAt: "", served: false, chunks: [] } as ReturnType<
				typeof listLocalCatalog
			>,
		};
	}
	return {
		needsLogin: false,
		signedIn: Boolean(locals.user),
		documents: await listRagDocuments(),
		adminEnabled: ragAdminEnabled(),
		// Read-only: the committed Tier-A catalog (gap-map categories, exemplars, stack-map) so its
		// chunks are visible here even though they're built offline, not edited through this console.
		catalog: listLocalCatalog(),
	};
};

/** FK-safe actor id for createdBy/audit: a real user id (24-hex) or null (mirrors saveReport). */
function actorId(locals: App.Locals): string | null {
	return locals.user?._id?.toString() ?? null;
}

/** Audit a RAG mutation: attributed to the signed-in admin, hashed IP, redacted summary (no content). */
async function auditRag(
	cookies: Cookies,
	locals: App.Locals,
	ip: string | null,
	action: string,
	target: string,
	summary?: string
): Promise<void> {
	logAdminActionSafe({
		actor: await adminActor(cookies, locals),
		action,
		target,
		summary,
		ip,
	});
}

function mapWriteError(e: unknown) {
	if (e instanceof RagConflictError) {
		return fail(409, { error: "This document was changed since you loaded it. Reload and retry." });
	}
	if (e instanceof RagNotFoundError) {
		return fail(404, { error: "Document not found." });
	}
	if (e instanceof RagWriteError) {
		return fail(400, { error: e.message });
	}
	return fail(500, { error: e instanceof Error ? e.message : "Unexpected error." });
}

const str = (fd: FormData, k: string): string => String(fd.get(k) ?? "").trim();
/** The OCC token is the document's monotonic version (a positive integer); NaN ⇒ missing/invalid. */
const ver = (fd: FormData): number => {
	const n = Number(fd.get("expectedVersion"));
	return Number.isInteger(n) && n > 0 ? n : NaN;
};

export const actions: Actions = {
	create: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { rag: "write" });
		const fd = await request.formData();
		const title = str(fd, "title");
		const text = str(fd, "text");
		const source = str(fd, "source");
		const sourceDate = str(fd, "sourceDate");
		if (!title || !text || !source || !sourceDate) {
			return fail(400, {
				error: "Title, text, source, and source date are all required.",
				form: "create",
			});
		}
		try {
			const { doc, duplicateChunkCount } = await createRagDocument(
				{
					title,
					text,
					source,
					url: str(fd, "url") || null,
					sourceType: str(fd, "sourceType") || null,
					sourceDate,
				},
				actorId(locals)
			);
			await auditRag(
				cookies,
				locals,
				getClientAddress(),
				"rag.create",
				doc.id,
				`created: ${title.slice(0, 80)}`
			);
			return {
				ok: true,
				action: "create",
				id: doc.id,
				warning:
					duplicateChunkCount > 0
						? `Heads up: ${duplicateChunkCount} chunk(s) duplicate text already in the store.`
						: undefined,
			};
		} catch (e) {
			return mapWriteError(e);
		}
	},

	update: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { rag: "write" });
		const fd = await request.formData();
		const id = str(fd, "id");
		const expectedVersion = ver(fd);
		if (!id || Number.isNaN(expectedVersion)) {
			return fail(400, { error: "Missing document id or version token." });
		}
		// Required metadata must stay non-empty (the edit form pre-fills these); url/sourceType optional.
		const title = str(fd, "title");
		const source = str(fd, "source");
		const sourceDate = str(fd, "sourceDate");
		if (!title || !source || !sourceDate) {
			return fail(400, {
				error: "Title, source, and source date are required.",
				form: "update",
				id,
			});
		}
		try {
			await updateRagDocument(
				id,
				{
					title,
					source,
					sourceDate,
					url: str(fd, "url") || null,
					sourceType: str(fd, "sourceType") || null,
				},
				expectedVersion,
				actorId(locals)
			);
			await auditRag(
				cookies,
				locals,
				getClientAddress(),
				"rag.update",
				id,
				`updated: ${title.slice(0, 80)}`
			);
			return { ok: true, action: "update", id };
		} catch (e) {
			return mapWriteError(e);
		}
	},

	activate: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { rag: "write" });
		const fd = await request.formData();
		const id = str(fd, "id");
		const expectedVersion = ver(fd);
		if (!id || Number.isNaN(expectedVersion)) {
			return fail(400, { error: "Missing document id or version token." });
		}
		try {
			await activateRagDocument(id, expectedVersion, actorId(locals));
			await auditRag(cookies, locals, getClientAddress(), "rag.activate", id);
			return { ok: true, action: "activate", id };
		} catch (e) {
			return mapWriteError(e);
		}
	},

	retire: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { rag: "write" });
		const fd = await request.formData();
		const id = str(fd, "id");
		const expectedVersion = ver(fd);
		if (!id || Number.isNaN(expectedVersion)) {
			return fail(400, { error: "Missing document id or version token." });
		}
		try {
			await retireRagDocument(id, expectedVersion, actorId(locals));
			await auditRag(cookies, locals, getClientAddress(), "rag.retire", id);
			return { ok: true, action: "retire", id };
		} catch (e) {
			return mapWriteError(e);
		}
	},

	reembed: async ({ request, locals, cookies, getClientAddress }) => {
		await requireAdminPermission({ cookies, locals }, { rag: "write" });
		const fd = await request.formData();
		const id = str(fd, "id");
		const expectedVersion = ver(fd);
		if (!id || Number.isNaN(expectedVersion)) {
			return fail(400, { error: "Missing document id or version token." });
		}
		try {
			await reembedRagDocument(id, expectedVersion, actorId(locals));
			await auditRag(cookies, locals, getClientAddress(), "rag.reembed", id);
			return { ok: true, action: "reembed", id };
		} catch (e) {
			return mapWriteError(e);
		}
	},
};

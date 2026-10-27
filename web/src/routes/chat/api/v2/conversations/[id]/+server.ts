import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import { formerWorkspaceNameOf, hasWorkspaceMark } from "$lib/chat/server/formerWorkspaces";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { ObjectId } from "bson";
import { syncBump, tombstoneConversations } from "$lib/chat/server/sync/syncTouch";
import { getEffectiveValidModelIdSchema, prewarmLocalModelForUser } from "$lib/chat/server/localModels";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { deleteConversationsCascade } from "$lib/chat/server/db/deleteConversations";
import {
	CustodialWipeError,
	hubRateLimitedError,
} from "$lib/chat/server/storage/custodialStorage";
import { resolveFaultInjection } from "$lib/chat/server/textGeneration/faultInjection";
import { CHAT_DELETE_BUSY_MESSAGE } from "$lib/chat/constants/custodialUpload";
import { hubBusyResponse } from "$lib/chat/server/storage/hubBusy";
import { logger } from "$lib/chat/server/logger";
import { effectivePreprompt, resolveTurnPreferences } from "$lib/chat/server/textGeneration/turnPreferences";

export const GET: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const conversation = await resolveConversation(params.id ?? "", locals);
	// A chat from a workspace this person left, or that was deleted, opens read-only. (CUR-3040)
	const scope = hasWorkspaceMark(conversation)
		? await workspaceScopeFor(locals, request?.headers)
		: null;
	const formerWorkspace = scope ? formerWorkspaceNameOf(conversation, scope) : null;

	return superjsonResponse({
		messages: conversation.messages,
		title: conversation.title,
		model: conversation.model,
		// The instructions the next turn will use, from the same resolution the turn reads. (CUR-1443)
		preprompt: effectivePreprompt(conversation.preprompt, await resolveTurnPreferences(locals)),
		rootMessageId: conversation.rootMessageId,
		id: conversation._id.toString(),
		updatedAt: conversation.updatedAt,
		modelId: conversation.model,
		shared: conversation.shared,
		formerWorkspace,
	});
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) {
		error(400, "Invalid conversation ID");
	}
	// Scope to the caller, then FK-ordered cascade (a bare delete throws if the conversation
	// has a report — reports.conversationId is a NOT NULL FK).
	const conv = await collections.conversations.findOne({
		_id: new ObjectId(id),
		...authCondition(locals),
	});
	if (!conv) {
		error(404, "Conversation not found");
	}
	try {
		// The `storage_hub_rate_limited` fault (preview only) fails the folder wipe as a throttled Hub does.
		if ((await resolveFaultInjection(request)) === "storage_hub_rate_limited") {
			throw new CustodialWipeError(0, 0, hubRateLimitedError("https://huggingface.co/api/buckets (fault injection)"));
		}
		await deleteConversationsCascade(
			[conv._id.toString()],
			conv.userId?.toString(),
			conv.userId ? undefined : conv.sessionId
		);
		await tombstoneConversations(locals, [conv]);
	} catch (e) {
		// The chat's bucket folder goes first, so a failed wipe leaves the chat whole. A Hugging
		// Face throttle (3,000 Hub calls per 5 minutes) is the busy answer the storage routes give
		// (CUR-3120); any other wipe failure is a 502 that says the chat was kept. (CUR-3666)
		if (e instanceof CustodialWipeError) {
			const busy = hubBusyResponse(e, CHAT_DELETE_BUSY_MESSAGE, "delete");
			if (busy) return busy;
			logger.error({ err: e, cause: e.cause }, "[delete] custodial storage delete failed");
			error(502, "We couldn't delete this chat's files, so the chat was kept. Please try again.");
		}
		throw e;
	}

	return superjsonResponse({ success: true });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const body = await request.json();
	const title = body?.title as string | undefined;
	const model = body?.model as string | undefined;

	if (title !== undefined) {
		if (typeof title !== "string" || title.length === 0 || title.length > 100) {
			error(400, "Title must be a string between 1 and 100 characters");
		}
	}

	if (model !== undefined) {
		// Per-request: THIS user's effective registry (catalog + their own local endpoint, if any).
		const effectiveValidModelIdSchema = await getEffectiveValidModelIdSchema(locals);
		if (!effectiveValidModelIdSchema.safeParse(model).success) {
			error(400, "Invalid model ID");
		}
		// Best-effort only (CUR-1194): give a cold local instance a head start on a mid-conversation
		// model switch. No-ops instantly for any non-local model. Routed through runInBackground, not a
		// bare `void` — see conversation/[id]/+server.ts's PATCH handler for why a fire-and-forget
		// promise alone would silently no-op on Vercel.
		void runInBackground(prewarmLocalModelForUser(locals, model));
	}

	const updateValues = {
		...(title !== undefined && {
			title: title.replace(/<\/?think>/gi, "").trim(),
			...syncBump(locals),
		}),
		...(model !== undefined && { model }),
	};

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) {
		error(400, "Invalid conversation ID");
	}
	const res = await collections.conversations.updateOne(
		{
			_id: new ObjectId(id),
			...authCondition(locals),
		},
		{ $set: updateValues }
	);

	if (typeof res.matchedCount === "number" ? res.matchedCount === 0 : res.modifiedCount === 0) {
		error(404, "Conversation not found");
	}

	return superjsonResponse({ success: true });
};

// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/chat/server/api/utils/resolveConversation";
import { workspaceScopeFor } from "$lib/chat/server/currentWorkspace";
import { formerWorkspaceNameOf, hasWorkspaceMark } from "$lib/chat/server/formerWorkspaces";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";
import { ObjectId } from "bson";
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
import { setConversationTags, TAGS_PER_CHAT_MAX, type ConversationTag } from "$lib/chat/server/db/conversationTags";
import { effectivePreprompt, resolveTurnPreferences } from "$lib/chat/server/textGeneration/turnPreferences";
import { titleUpdate } from "$lib/chat/server/chat/sealedTurn";
import { conversationExpiryFor } from "$lib/chat/server/conversationExpiry";

export const GET: RequestHandler = async ({ locals, params, request }) => {
	requireAuth(locals);

	const conversation = await resolveConversation(params.id ?? "", locals);
	// A chat from a workspace this person left, or that was deleted, opens read-only.
	const scope = hasWorkspaceMark(conversation)
		? await workspaceScopeFor(locals, request?.headers)
		: null;
	const formerWorkspace = scope ? formerWorkspaceNameOf(conversation, scope) : null;
	const prefs = await resolveTurnPreferences(locals);
	// When this chat is deleted under conversation expiry, for its owner only, signed in or a
	// guest; null while expiry is off, or when the person reading is not its owner.
	const owner = conversation.userId
		? conversation.userId.toString() === locals.user?._id?.toString()
		: Boolean(locals.sessionId) && conversation.sessionId === locals.sessionId;
	const expiresAt = owner ? await conversationExpiryFor(conversation) : null;

	return superjsonResponse({
		// A sealed message carries its text in `sealed`; the browser opens it.
		messages: conversation.messages,
		title: conversation.title,
		sealedTitle: conversation.sealedTitle,
		sealedTitleRev: conversation.sealedTitleRev,
		model: conversation.model,
		// The instructions the next turn will use, from the same resolution the turn reads.
		preprompt: effectivePreprompt(conversation.preprompt, prefs),
		// The sealed preprompt goes to the browser even when personal instructions win over it: a turn
		// still posts it back opened, checked against its MAC. It is ciphertext only the owner's
		// history key opens. `personalInstructionsApply` tells the browser to keep showing `preprompt`
		// above, the instructions the next answer gets, instead of the sealed text it opens.
		sealedPreprompt: conversation.sealedPreprompt,
		sealedPrepromptRev: conversation.sealedPrepromptRev,
		personalInstructionsApply: Boolean(prefs.personalInstructions),
		rootMessageId: conversation.rootMessageId,
		id: conversation._id.toString(),
		updatedAt: conversation.updatedAt,
		modelId: conversation.model,
		shared: conversation.shared,
		formerWorkspace,
		// The Mila output guard ended this conversation: the page shows a status line in place of the composer.
		crisisEnded: Boolean(conversation.crisisEndedAt),
		expiresAt,
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
	} catch (e) {
		// The chat's bucket folder goes first, so a failed wipe leaves the chat whole. A Hugging
		// Face throttle (3,000 Hub calls per 5 minutes) is the busy answer the storage routes give;
		// any other wipe failure is a 502 that says the chat was kept.
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
	const pinned = body?.pinned as boolean | undefined;
	const archived = body?.archived as boolean | undefined;
	// The chat's whole tag list, as names the person typed.
	const tags = body?.tags as unknown;

	if (title !== undefined) {
		if (typeof title !== "string" || title.length === 0 || title.length > 100) {
			error(400, "Title must be a string between 1 and 100 characters");
		}
	}

	for (const [name, flag] of [["pinned", pinned], ["archived", archived]] as const) {
		if (flag !== undefined && typeof flag !== "boolean") error(400, `${name} must be a boolean`);
	}

	if (tags !== undefined) {
		if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string") || tags.length > TAGS_PER_CHAT_MAX) {
			error(400, `tags must be a list of at most ${TAGS_PER_CHAT_MAX} names`);
		}
		// A tag row is keyed on the account, so a guest has nowhere to keep one.
		if (!locals.user?._id) error(403, "Sign in to tag chats.");
	}

	if (model !== undefined) {
		// Per-request: THIS user's effective registry (catalog + their own local endpoint, if any).
		const effectiveValidModelIdSchema = await getEffectiveValidModelIdSchema(locals);
		if (!effectiveValidModelIdSchema.safeParse(model).success) {
			error(400, "Invalid model ID");
		}
		// Best-effort only: give a cold local instance a head start on a mid-conversation
		// model switch. No-ops instantly for any non-local model. Routed through runInBackground, not a
		// bare `void` — see conversation/[id]/+server.ts's PATCH handler for why a fire-and-forget
		// promise alone would silently no-op on Vercel.
		void runInBackground(prewarmLocalModelForUser(locals, model));
	}

	const updateValues = {
		...(title !== undefined && {
			title: title.replace(/<\/?think>/gi, "").trim(),
		}),
		...(model !== undefined && { model }),
		...(pinned !== undefined && { pinned }),
		// Archiving unpins: an archived chat has left the list the pin orders.
		...(archived !== undefined && { archived, ...(archived && pinned === undefined && { pinned: false }) }),
	};

	const id = params.id ?? "";
	if (!ObjectId.isValid(id)) {
		error(400, "Invalid conversation ID");
	}
	const where = { _id: new ObjectId(id), ...authCondition(locals) };

	let storedTags: ConversationTag[] | undefined;
	if (tags !== undefined && locals.user?._id) {
		storedTags = (await setConversationTags(locals.user._id.toString(), where, tags as string[])) ?? undefined;
		if (!storedTags) error(404, "Conversation not found");
	}

	if (Object.keys(updateValues).length > 0 || tags === undefined) {
		// A new title is sealed while sealing is on, or clears a sealed one, which would otherwise win
		// over it. The owner and the title's revision come from the stored row.
		let update: { $set: Record<string, unknown>; $unset?: Record<string, unknown> } = { $set: updateValues };
		if (updateValues.title !== undefined) {
			const stored = await collections.conversations.findOne(where);
			if (!stored) error(404, "Conversation not found");
			const titled = await titleUpdate(id, stored, updateValues.title);
			update = { $set: { ...updateValues, ...titled.$set }, ...(titled.$unset && { $unset: titled.$unset }) };
		}
		const res = await collections.conversations.updateOne(where, update);

		if (typeof res.matchedCount === "number" ? res.matchedCount === 0 : res.modifiedCount === 0) {
			error(404, "Conversation not found");
		}
	}

	return superjsonResponse({ success: true, ...(storedTags ? { tags: storedTags } : {}) });
};

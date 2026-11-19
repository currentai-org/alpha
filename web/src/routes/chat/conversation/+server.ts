// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import type { RequestHandler } from "./$types";
import { collections } from "$lib/chat/server/database";
import { ObjectId } from "bson";
import { error, redirect } from "@sveltejs/kit";
import { base } from "$lib/chat/paths";
import { z } from "zod";
import type { Message } from "$lib/chat/types/Message";
import {
	getEffectiveModels,
	getEffectiveValidModelIdSchema,
	prewarmLocalModelForUser,
} from "$lib/chat/server/localModels";
import { runInBackground } from "$lib/chat/server/vercelBackground";
import { v4 } from "uuid";
import { authCondition } from "$lib/chat/server/auth";
import { conversationLimitFor } from "$lib/chat/server/usageLimits";
import { conversationLimitMessage } from "$lib/chat/conversationLimit";
import {
	resolveFaultInjection,
	SESSION_RATE_LIMIT_FAULT,
} from "$lib/chat/server/textGeneration/faultInjection";
import { enforceRequestRateLimits } from "$lib/chat/server/chat/rateLimit";
import { MetricsServer } from "$lib/chat/server/metrics";
import { activeWorkspaceIdFor } from "$lib/chat/server/currentWorkspace";
import { CLIENT_INSTRUCTIONS_MAX_CHARS, exceedsClientInstructionsCap } from "$lib/chat/server/clientInstructions";
import { conversationSealer, newMacSalt, sealPreprompt, splitMessage } from "$lib/chat/server/chat/sealedTurn";

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const body = await request.text();

	const title = "";

	// This user's effective registry (catalog + their own local endpoint, if any) — a local model id
	// only ever validates/resolves against this, never the raw global `models` export.
	const effectiveModels = await getEffectiveModels(locals);

	const parsedBody = z
		.object({
			model: await getEffectiveValidModelIdSchema(locals),
			preprompt: z.string().optional(),
		})
		.safeParse(JSON.parse(body));

	if (!parsedBody.success) {
		error(400, "Invalid request");
	}
	const values = parsedBody.data;

	const fault = await resolveFaultInjection(request);
	// Creates had no rate limit, so one client could insert conversations as fast as it could
	// POST. They get their own per-session and per-IP count at the turn rates, before anything is
	// written. `session_rate_limit_low` lowers it to one per window here too, so a spec can trip it.
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
		event: "conversationCreate",
		...(fault === "session_rate_limit_low" ? { perSession: SESSION_RATE_LIMIT_FAULT } : {}),
	});

	const convCount = await collections.conversations.countDocuments(authCondition(locals));
	// `conversation_limit_reached` (preview only, see faultInjection.ts) refuses here as if
	// this visitor already held the cap, so a spec reaches the refusal without making 100 chats.
	const limitFault = fault === "conversation_limit_reached";

	// `>=`, since the count is taken before this create, so `>` let an account reach limit + 1.
	// Sign-in can carry an account well past the cap, so the refusal says how many to delete. The fault
	// speaks as a visitor holding exactly the cap, so the spec reads the same words a real refusal uses.
	// A team account gets the staff tier's cap.
	const limit = conversationLimitFor(locals.user);
	if (limitFault) {
		error(429, conversationLimitMessage(limit ?? 100, limit ?? 100));
	}
	if (limit && convCount >= limit) {
		error(429, conversationLimitMessage(convCount, limit));
	}

	const model = effectiveModels.find((m) => (m.id || m.name) === values.model);

	if (!model) {
		error(400, "Invalid model");
	}

	const messages: Message[] = [
		{
			id: v4(),
			from: "system",
			content: values.preprompt ?? "",
			createdAt: new Date(),
			updatedAt: new Date(),
			children: [],
			ancestors: [],
		},
	];

	const rootMessageId: Message["id"] = messages[0].id;

	if (model.unlisted) {
		error(400, "Can't start a conversation with an unlisted model");
	}

	// A caller-written preprompt sits in the system role on every turn; bound it.
	if (exceedsClientInstructionsCap(values.preprompt, model.preprompt)) {
		error(400, `Instructions are limited to ${CLIENT_INSTRUCTIONS_MAX_CHARS} characters`);
	}

	// Best-effort only: give a cold local instance a head start before the first real
	// message arrives. No-ops instantly for any non-local model. Routed through runInBackground, not a
	// bare `void` — see conversation/[id]/+server.ts's PATCH handler for why a fire-and-forget promise
	// alone would silently no-op on Vercel.
	void runInBackground(prewarmLocalModelForUser(locals, values.model));

	// use provided preprompt or model preprompt
	values.preprompt ??= model?.preprompt ?? "";

	if (messages && messages.length > 0 && messages[0].from === "system") {
		messages[0].content = values.preprompt;
	}

	const _id = new ObjectId();
	const owner = locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId };
	// An enrolled owner's preprompt is never stored in plaintext: it is sealed here with the
	// root system message that repeats it, whatever tab asked. The server decides from enrollment alone.
	// No sealer (sealing off, no history key) leaves both plaintext. A recipient or key store that fails
	// throws out of `conversationSealer`, so the create fails and no row is written.
	const sealer = await conversationSealer(_id.toString(), owner);
	// The salts go back to the creating tab with the words, as its post would carry them from an opened
	// blob.
	const salts = { preprompt: newMacSalt(), root: newMacSalt() };
	const sealedPreprompt = sealer ? await sealPreprompt(sealer, { preprompt: values.preprompt, rootMessageId, messages }, salts) : null;
	// What the creating tab sent, in the turn's post shape, so it can post it back on its first turn
	// without opening anything: a tab that has not unlocked can still start a chat.
	const opened = sealedPreprompt && {
		preprompt: { rev: sealedPreprompt.fields.sealedPrepromptRev, text: values.preprompt, salt: salts.preprompt },
		history: sealedPreprompt.root
			? [{ id: messages[0].id, rev: sealedPreprompt.root.sealedRev, body: splitMessage(messages[0]).body, salt: salts.root }]
			: [],
	};
	if (sealedPreprompt?.root) messages[0] = sealedPreprompt.root;

	const res = await collections.conversations.insertOne({
		_id,
		// Always store sanitized titles
		title: (title || "New Chat").replace(/<\/?think>/gi, "").trim(),
		rootMessageId,
		messages,
		model: values.model,
		preprompt: values.preprompt,
		...sealedPreprompt?.fields,
		createdAt: new Date(),
		updatedAt: new Date(),
		...owner,
		// Workspace for usage counting; see the organizationId comment on schema.ts.
		organizationId: await activeWorkspaceIdFor(locals, request.headers),
	});

	if (MetricsServer.isEnabled()) {
		MetricsServer.getMetrics().model.conversationsTotal.inc({ model: values.model });
	}

	return new Response(
		JSON.stringify({
			conversationId: res.insertedId.toString(),
			...(opened ? { opened } : {}),
		}),
		{ headers: { "Content-Type": "application/json" } }
	);
};

export const GET: RequestHandler = async () => {
	redirect(302, `${base}/`);
};

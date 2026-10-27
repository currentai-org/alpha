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
import { getAuth } from "$lib/chat/server/betterAuth";
import { workspacesEnabled } from "$lib/chat/server/workspacesGate";
import { CLIENT_INSTRUCTIONS_MAX_CHARS, exceedsClientInstructionsCap } from "$lib/chat/server/clientInstructions";

// Which workspace (if any) this conversation should be attributed to for usage counting —
// see the organizationId comment on schema.ts's conversations table. Signed-out visitors and users
// with no active workspace both get undefined, same as before this column existed. (CUR-961)
async function activeOrganizationId(
	locals: App.Locals,
	headers: Headers
): Promise<string | undefined> {
	if (!workspacesEnabled() || !locals.user) return undefined;
	const session = await getAuth().api.getSession({ headers });
	return session?.session.activeOrganizationId ?? undefined;
}

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
	// written. `session_rate_limit_low` lowers it to one per window here too, so a spec can trip it. (CUR-3529)
	await enforceRequestRateLimits({
		userId: locals.user?._id ?? locals.sessionId,
		clientAddress: getClientAddress(),
		event: "conversationCreate",
		...(fault === "session_rate_limit_low" ? { perSession: SESSION_RATE_LIMIT_FAULT } : {}),
	});

	const convCount = await collections.conversations.countDocuments(authCondition(locals));
	// `conversation_limit_reached` (preview only, see faultInjection.ts) refuses here as if
	// this visitor already held the cap, so a spec reaches the refusal without making 100 chats. (CUR-2875)
	const limitFault = fault === "conversation_limit_reached";

	// `>=`, since the count is taken before this create, so `>` let an account reach limit + 1.
	// Sign-in can carry an account well past the cap, so the refusal says how many to delete. The fault
	// speaks as a visitor holding exactly the cap, so the spec reads the same words a real refusal uses. (CUR-2891)
	// A team account gets the staff tier's cap. (CUR-4620)
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

	// A caller-written preprompt sits in the system role on every turn; bound it. (CUR-3528)
	if (exceedsClientInstructionsCap(values.preprompt, model.preprompt)) {
		error(400, `Instructions are limited to ${CLIENT_INSTRUCTIONS_MAX_CHARS} characters`);
	}

	// Best-effort only (CUR-1194): give a cold local instance a head start before the first real
	// message arrives. No-ops instantly for any non-local model. Routed through runInBackground, not a
	// bare `void` — see conversation/[id]/+server.ts's PATCH handler for why a fire-and-forget promise
	// alone would silently no-op on Vercel.
	void runInBackground(prewarmLocalModelForUser(locals, values.model));

	// use provided preprompt or model preprompt
	values.preprompt ??= model?.preprompt ?? "";

	if (messages && messages.length > 0 && messages[0].from === "system") {
		messages[0].content = values.preprompt;
	}

	const res = await collections.conversations.insertOne({
		_id: new ObjectId(),
		// Always store sanitized titles
		title: (title || "New Chat").replace(/<\/?think>/gi, "").trim(),
		rootMessageId,
		messages,
		model: values.model,
		preprompt: values.preprompt,
		createdAt: new Date(),
		updatedAt: new Date(),
		...(locals.user ? { userId: locals.user._id } : { sessionId: locals.sessionId }),
		organizationId: await activeOrganizationId(locals, request.headers),
	});

	if (MetricsServer.isEnabled()) {
		MetricsServer.getMetrics().model.conversationsTotal.inc({ model: values.model });
	}

	return new Response(
		JSON.stringify({
			conversationId: res.insertedId.toString(),
		}),
		{ headers: { "Content-Type": "application/json" } }
	);
};

export const GET: RequestHandler = async () => {
	redirect(302, `${base}/`);
};

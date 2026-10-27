import type { RequestHandler } from "@sveltejs/kit";
import { defaultModel } from "$lib/chat/server/models";
import { syncGate, syncJson } from "$lib/chat/server/sync/syncGate";
import { applyPush } from "$lib/chat/server/sync/syncPush";
import { conversationLimitFor } from "$lib/chat/server/usageLimits";
import { PUSH_LIMITS, pushBodySchema } from "$lib/chat/server/sync/syncWire";

/** POST /chat/api/v2/sync/push (CUR-4312): apply a sync client's changes. Contract: syncPush.ts. */
export const POST: RequestHandler = async ({ locals, request }) => {
	const caller = syncGate(locals);
	if (caller instanceof Response) return caller;

	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > PUSH_LIMITS.bodyBytes) return syncJson(413, { error: "too_large" });
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > PUSH_LIMITS.bodyBytes) return syncJson(413, { error: "too_large" });
	const text = new TextDecoder().decode(bytes);

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return syncJson(400, { error: "invalid_json" });
	}
	const parsed = pushBodySchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		return syncJson(400, { error: "invalid_body", path: issue?.path.join("."), message: issue?.message });
	}
	const out = await applyPush(
		{ userId: caller.user._id, conversationLimit: conversationLimitFor(caller.user) },
		caller.clientId, parsed.data, defaultModel.id);
	return syncJson(200, out);
};

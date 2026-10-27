import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/chat/server/api/utils/requireAuth";
import { getLayoutSettings } from "$lib/chat/server/layoutData";
import { applySettingsUpdate } from "$lib/chat/server/api/utils/applySettingsUpdate";

export const GET: RequestHandler = async ({ locals }) => {
	requireAuth(locals);
	return superjsonResponse(await getLayoutSettings(locals));
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAuth(locals);
	await applySettingsUpdate(locals, await request.json());
	return new Response();
};

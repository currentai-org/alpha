import { applySettingsUpdate } from "$lib/chat/server/api/utils/applySettingsUpdate";

export async function POST({ request, locals }) {
	await applySettingsUpdate(locals, await request.json());
	return new Response();
}

import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutUser } from "$lib/chat/server/layoutData";

export const GET: RequestHandler = async ({ locals }) => {
	return superjsonResponse(getLayoutUser(locals));
};

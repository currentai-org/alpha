import { error, type RequestHandler } from "@sveltejs/kit";
import { resolveModel } from "$lib/chat/server/api/utils/resolveModel";
import { collections } from "$lib/chat/server/database";
import { authCondition } from "$lib/chat/server/auth";

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.sessionId) {
		error(401, "Unauthorized");
	}

	const model = await resolveModel(params.namespace ?? "");

	await collections.settings.updateOne(
		authCondition(locals),
		{
			$set: {
				activeModel: model.id,
				updatedAt: new Date(),
			},
			$setOnInsert: {
				createdAt: new Date(),
			},
		},
		{ upsert: true }
	);

	return new Response();
};

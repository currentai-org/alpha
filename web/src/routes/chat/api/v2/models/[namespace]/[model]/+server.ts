import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/chat/server/api/utils/superjsonResponse";
import { getLayoutModels } from "$lib/chat/server/layoutData";

// Answers with the same public fields the model list sends (getLayoutModels), never the registry
// entry itself: that carries `endpoints`, and each endpoint's `apiKey` would go out to anyone who asked.
export const GET: RequestHandler = async ({ params, locals }) => {
	const id = `${params.namespace ?? ""}/${params.model ?? ""}`;
	const model = (await getLayoutModels(locals)).find((m) => m.id === id);
	if (!model) error(404, "Model not found");
	return superjsonResponse(model, { headers: { "Cache-Control": "private, max-age=60" } });
};

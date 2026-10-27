import { config } from "$lib/chat/server/config";
import { baseURLForModel, resolveServing, type ServingProvenance } from "$lib/chat/servingProvenance";

type ModelEndpoints = Parameters<typeof baseURLForModel>[0];

/**
 * The serving facts for one model on this deployment: its own endpoint (or the deployment default),
 * the Folkways adapter route unwrapped to its upstream (CUR-3573), and the configured sovereign
 * hosts. Every server surface that says where an answer runs reads them here, so the welcome, the
 * system prompt and the provenance API cannot disagree about one model.
 */
export function servingFor(model: ModelEndpoints, servedModelId?: string): ServingProvenance {
	return resolveServing(
		baseURLForModel(
			model,
			config.OPENAI_BASE_URL,
			Reflect.get(config, "FOLKWAYS_UPSTREAM_BASE_URL") as string | undefined
		),
		servedModelId,
		Reflect.get(config, "SOVEREIGN_HOSTS") as string | undefined
	);
}

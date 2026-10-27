import type { Model } from '$lib/chat/types/Model';
import type { GETModelsResponse } from '$lib/chat/server/api/types';
import { catalog } from '$lib/chat/routing/catalog';
import { demoPickerCatalog } from '$lib/chat/routing/wwwPicker';

/** The gateway id of a catalog model the demo serves; throws when the catalog no longer has it. */
export function demoGatewayId(catalogId: string): string {
	const id = catalog.find((m) => m.id === catalogId)?.gatewayId;
	if (!id)
		throw new Error(
			`The /alpha demo needs "${catalogId}" in the routing catalog, served through the gateway.`
		);
	return id;
}

/** Demo default — Alpha's main model. */
export const DEMO_MODEL_ID = demoGatewayId('apertus-70b');

/** One entry in the demo's model list, shaped like the real app's. */
function demoModel(id: string, name: string, description: string) {
	return {
		id,
		name: id,
		displayName: name,
		description,
		multimodal: false,
		parameters: { stop_sequences: undefined },
		promptExamples: [],
		providers: [{ provider: 'demo' }],
		supportsTools: true,
		supportsReasoning: false,
		supportsArtifacts: false,
		isRouter: false,
		unlisted: false,
		hasInferenceAPI: false
	} satisfies Model;
}

/**
 * The demo stands in for www, so it serves www's picker list in its order, including a model withdrawn
 * for now (config/picker.ts's WITHDRAWN), whose recorded answers still play here.
 */
export const demoModels: GETModelsResponse = demoPickerCatalog.map((m) =>
	demoModel(m.gatewayId!, m.name, m.strength)
);

export const demoCurrentModel: Model = demoModels.find((m) => m.id === DEMO_MODEL_ID) as Model;

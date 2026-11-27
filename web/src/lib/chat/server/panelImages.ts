import { catalogByGatewayId } from "$lib/chat/routing/catalog";

/** Can this panel model see an image? The routing catalog's `readsImages` decides, and a model the
 *  catalog doesn't list is text-only: every panel model is a picker model the catalog lists, now that
 *  no panelist rides the Hugging Face router. Whether this request may send an image is
 *  still the deployment's multimodal gate, which the caller asks. */
export function panelModelReadsImages(modelId: string): boolean {
	return catalogByGatewayId(modelId)?.readsImages ?? false;
}

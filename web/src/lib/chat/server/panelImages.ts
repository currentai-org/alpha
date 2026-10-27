import { catalogByGatewayId } from "$lib/chat/routing/catalog";

/**
 * Second-opinion panel ids the routing catalog doesn't list that read images, as the HF router's
 * `/v1/models` lists their `input_modalities` (both `["text", "image"]`, CUR-4670). The
 * panel rides that router, and the compare models are registered without a catalog fetch, so this is
 * the one place the fact lives for them. A catalogued id is never listed here: the catalog's
 * `readsImages` decides it.
 */
const UNCATALOGUED_PANEL_IMAGE_READERS: ReadonlySet<string> = new Set([
	"google/gemma-4-31B-it",
	"Qwen/Qwen3.6-35B-A3B",
]);

/** Can this panel model see an image? The catalog's `readsImages` first, then the list above. Whether
 *  this request may send one is still the deployment's multimodal gate, which the caller asks. */
export function panelModelReadsImages(modelId: string): boolean {
	const entry = catalogByGatewayId(modelId);
	return entry ? entry.readsImages : UNCATALOGUED_PANEL_IMAGE_READERS.has(modelId);
}

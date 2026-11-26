import { BRAND_DEFAULTS, PROJECT, isDefaultBrand, resolveBrand, type Brand } from "$lib/chat/brand";

/** This install's names, read from env on each call so a test can stub them. */
export function serverBrand(): Brand {
	return resolveBrand(process.env);
}

/** Fill {product} and {organisation} in model-facing text with this install's names. */
export function fillBrand(text: string, brand: Brand = serverBrand()): string {
	return text.replaceAll("{product}", brand.product).replaceAll("{organisation}", brand.organisation);
}

/** The sentence that tells the model which project the app comes from. On an install with today's
 *  names it is the app's own description; on a renamed one it says the app is built from the project. */
export function aboutProjectSentence(brand: Brand = serverBrand()): string {
	return isDefaultBrand(brand)
		? `You are the open, map-grounded chat surface of ${BRAND_DEFAULTS.product} — ${BRAND_DEFAULTS.organisation}'s nonprofit effort to assemble a full-stack, open source alternative to closed AI from open components.`
		: `You are the open, map-grounded chat surface of ${brand.product}, built from ${PROJECT.name} — ${PROJECT.organisation}'s open source effort to assemble a full-stack, open source alternative to closed AI from open components.`;
}

/** The sentence that gives the assistant this install's name, or "" when it has none. Keeps {model},
 *  so a caller fills it before the model name. */
export function assistantNameSentence(brand: Brand = serverBrand()): string {
	return brand.assistant
		? ` On this app you are called ${brand.assistant}; when asked your name, say you are ${brand.assistant}, running on {model}.`
		: "";
}

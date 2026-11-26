// The names an install puts on the chat: who runs it, what the app is called, and what the assistant
// calls itself. Read at runtime from the server's env, because a self-host runs a prebuilt image and
// a build-time value could not be changed without rebuilding it. Imports nothing, so client code can
// use the type and the defaults.

export type Brand = {
	/** Who runs this install, as in "a chat app that <organisation> runs". */
	organisation: string;
	/** The app's name, shown in the header, the sidebar and the page title. */
	product: string;
	/** A name the assistant answers to on this install. Null: it answers with its model's name. */
	assistant: string | null;
};

/** Today's names. An install that sets nothing shows exactly these. */
export const BRAND_DEFAULTS: Brand = Object.freeze({
	organisation: 'Current AI',
	product: 'AI Potluck',
	assistant: null
});

/** Facts about the open source project this app comes from. They stay true on every install, so they
 *  never take the install's own names: credits, the public catalog, the contribute page. */
export const PROJECT = Object.freeze({ name: 'AI Potluck', organisation: 'Current AI' });

function named(value: string | undefined): string | undefined {
	const v = value?.trim();
	return v ? v : undefined;
}

/** The brand from env. A variable that is unset or blank keeps its default. `WEBUI_NAME`, the name an
 *  Open WebUI install already sets, is read as the product name when `BRAND_PRODUCT_NAME` is not. */
export function resolveBrand(env: Record<string, string | undefined>): Brand {
	return {
		organisation: named(env.BRAND_ORGANISATION_NAME) ?? BRAND_DEFAULTS.organisation,
		product: named(env.BRAND_PRODUCT_NAME) ?? named(env.WEBUI_NAME) ?? BRAND_DEFAULTS.product,
		assistant: named(env.BRAND_ASSISTANT_NAME) ?? BRAND_DEFAULTS.assistant
	};
}

/** True when the install shows today's names. */
export function isDefaultBrand(brand: Brand): boolean {
	return (
		brand.organisation === BRAND_DEFAULTS.organisation &&
		brand.product === BRAND_DEFAULTS.product &&
		brand.assistant === BRAND_DEFAULTS.assistant
	);
}

/** The brand a page's data carries (the chat shell loads it), or today's names where none is loaded. */
export function brandOf(data: unknown): Brand {
	const brand = (data as { brand?: Brand } | null | undefined)?.brand;
	return brand ?? BRAND_DEFAULTS;
}

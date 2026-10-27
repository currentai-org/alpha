// Where chat and /alpha reach the Potluck website (the gap map and the home-page game). Its Svelte
// components are in websiteChrome.ts, websiteSeo.ts and websiteAlpha.ts, one module per route.
//
// The website is private and absent from the public snapshot, so nothing outside the website imports
// it by name. Each export here is the website's piece when its file is present and `undefined` when
// it is not; callers treat undefined as "this part of the product is not there" (a link that is not
// shown, a page that falls back to its default content). The globs are literal because Vite resolves
// them at build time: a pattern that matches no file yields an empty object, not an error.
import type { Component } from 'svelte';

type AnyComponent = Component<Record<string, unknown>>;

const only = <T>(found: Record<string, T>): T | undefined => Object.values(found)[0];

/** The gap map's entity URL prefixes, or undefined when the gap map is not part of this build. */
export const entityBases: { product: string; org: string } | undefined = (() => {
	const mod = only(
		import.meta.glob<{ PRODUCT_BASE: string; ORG_BASE: string }>('/src/lib/gapmap/entityUrl.ts', {
			eager: true
		})
	);
	return mod ? { product: mod.PRODUCT_BASE, org: mod.ORG_BASE } : undefined;
})();

/** Loads the home-page game that the chat mark opens after five taps. */
export const loadPotluckRun: (() => Promise<{ default: AnyComponent }>) | undefined = only(
	import.meta.glob<{ default: AnyComponent }>('/src/lib/potluck-run/PotluckRun.svelte')
);

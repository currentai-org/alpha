// The website's page chrome, for the root layout: undefined when the website is not in the build.
// One module per component so a route imports only the pieces it renders.
import type { Component } from 'svelte';

type AnyComponent = Component<Record<string, unknown>>;

const only = <T>(found: Record<string, T>): T | undefined => Object.values(found)[0];
const component = (found: Record<string, { default: AnyComponent }>): AnyComponent | undefined =>
	only(found)?.default;

/** Site header, nav and footer around a page, and the ScrollSmoother wrapper that goes with them. */
export const SiteChrome = component(
	import.meta.glob<{ default: AnyComponent }>('/src/lib/website/SiteChrome.svelte', { eager: true })
);

/** ScrollSmoother for the site's content pages ($lib/scroll/smooth-scroll). Typed here rather than with
 *  `typeof import(...)` so a build without the module still typechecks. */
export const smoothScrolling = only(
	import.meta.glob<{
		syncSmoothScroll(enabled: boolean, from: URL | undefined, to: URL | undefined): Promise<void>;
		unclampScrollRestore(): void;
	}>('/src/lib/scroll/smooth-scroll.ts', { eager: true })
);

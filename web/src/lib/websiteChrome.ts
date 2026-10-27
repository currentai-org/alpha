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

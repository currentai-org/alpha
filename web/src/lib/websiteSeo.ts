// The website's CMS SEO tags, for the /chat landing: undefined when the website is not in the build.
import type { Component } from 'svelte';

type AnyComponent = Component<Record<string, unknown>>;

const only = <T>(found: Record<string, T>): T | undefined => Object.values(found)[0];
const component = (found: Record<string, { default: AnyComponent }>): AnyComponent | undefined =>
	only(found)?.default;

/** SEO tags from a CMS page document. */
export const PageSeo = component(
	import.meta.glob<{ default: AnyComponent }>('/src/lib/components/seo/page-seo.svelte', {
		eager: true
	})
);

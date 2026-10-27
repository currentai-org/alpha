// The website pieces the /alpha landing can use (live preview, rich text, the Handover look):
// undefined for each one that is not in the build.
import type { Component } from 'svelte';

type AnyComponent = Component<Record<string, unknown>>;

const only = <T>(found: Record<string, T>): T | undefined => Object.values(found)[0];
const component = (found: Record<string, { default: AnyComponent }>): AnyComponent | undefined =>
	only(found)?.default;

/** Payload's live-preview bridge for the /alpha landing page. */
export const LivePreviewListener = component(
	import.meta.glob<{ default: AnyComponent }>('/src/lib/payload/LivePreviewListener.svelte', {
		eager: true
	})
);

/** The /alpha landing's Handover look, built from the website's button block. */
export const HandoverLook = component(
	import.meta.glob<{ default: AnyComponent }>(
		'/src/lib/alpha-landing/looks/handover/HandoverLook.svelte',
		{
			eager: true
		}
	)
);

/** The CMS rich-text renderer, for the landing page's FAQ answers. */
export const LexicalRenderer = component(
	import.meta.glob<{ default: AnyComponent }>('/src/lib/lexical/lexical-renderer.svelte', {
		eager: true
	})
);

// The website's chat-link helper, on its own so a page that needs only a link does not load the rest of
// the /alpha landing's seam (websiteAlpha.ts eagerly loads the live-preview bridge, the Handover look and
// the rich-text renderer). Unchanged href without the CMS link helpers, which a build with no www host
// does not need.
const links = Object.values(
	import.meta.glob<{ chatLinkHref(href: string): string }>('/src/lib/payload/links.ts', {
		eager: true
	})
)[0];

/** A code-owned `/chat…` link, sent to the chat host on www. */
export const chatLinkHref = (href: string): string => (links ? links.chatLinkHref(href) : href);

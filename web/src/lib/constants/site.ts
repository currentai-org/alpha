import { env } from '$env/dynamic/public';
import { lexicalToPlainText } from '$lib/lexical/to-plain-text';

/** Resolved image reference (Payload media, or a legacy hand-edited path string). */
export type CloudImage = {
	src: string;
	alt?: string;
	width?: number | null;
	height?: number | null;
};

/**
 * The origin every absolute URL on the market-map side is built from.
 *
 * `PUBLIC_ORIGIN` wins: it is set per environment and is already what the chat half treats as
 * canonical (`ChatShell.svelte`), so preferring it puts both halves of the app on one variable
 * instead of two parallel systems. `__SITE_ORIGIN__` (baked from VERCEL_PROJECT_PRODUCTION_URL
 * at build) stays as the fallback, so behaviour is unchanged wherever PUBLIC_ORIGIN is absent.
 *
 * Chat can fall back to `page.url.origin` and this cannot: these pages are prerendered, so the
 * request origin is a build artifact rather than the serving host — the reason the build-time
 * constant exists at all.
 */
const SITE_ORIGIN = (env.PUBLIC_ORIGIN || __SITE_ORIGIN__).replace(/\/$/, '');

/**
 * Default Open Graph image, used on every page unless the page sets its own `seo.ogImage`.
 * Served from `static/`. Absolute, because social scrapers fetch it out of context — unlike
 * the favicons in `app.html`, which stay relative and so follow whatever host serves the page.
 */
export const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/ai-potluck-og-home.jpg`;

/** Dedicated Gap Map OG image, used on `/map` instead of `DEFAULT_OG_IMAGE`. */
export const GAPMAP_OG_IMAGE = `${SITE_ORIGIN}/gapmap-og.png`;

/**
 * Resolve a page's OG image to a URL, falling back to `fallbackImage` (defaults to
 * `DEFAULT_OG_IMAGE`) when the page has none set.
 */
export function resolveOgImage(
	ogImage?: CloudImage | string | null,
	fallbackImage: string = DEFAULT_OG_IMAGE
): string {
	if (!ogImage) return fallbackImage;
	if (typeof ogImage === 'string') return ogImage;
	return ogImage.src || fallbackImage;
}

/** Suffix applied to a page's title when no `meta.title` is set in Payload. */
const TITLE_SUFFIX = env.PUBLIC_SEO_TITLE_SUFFIX ?? ' – AI Potluck';

/**
 * Resolve a page's `<title>` / `og:title` value: the editor-authored SEO title
 * if set, otherwise the page title suffixed with `PUBLIC_SEO_TITLE_SUFFIX`.
 */
export function resolvePageTitle(page: {
	title: string;
	meta?: { title?: string | null } | null;
}): string {
	return page.meta?.title ?? `${page.title}${TITLE_SUFFIX}`;
}

/**
 * Resolve a page's canonical / `og:url` value from its pathname. Same rationale as
 * `DEFAULT_OG_IMAGE` above: prerendered pages can't trust `page.url.origin`, but
 * `page.url.pathname` is the real matched path even during prerender, so only the
 * origin needs the build-time constant.
 */
export function resolveCanonicalUrl(pathname: string): string {
	return `${SITE_ORIGIN}${pathname}`;
}

/**
 * Truncate `text` to `maxLength`, breaking on the last whole word so a description
 * never ends mid-word — a frontend port of `lexicalToExcerpt`'s truncator
 * (payload/src/fields/lexicalPlainText.ts), for descriptions that don't come from
 * Payload's own excerpt generator (e.g. the gap-map product/org pages).
 */
export function truncateOnWordBoundary(text: string, maxLength = 150): string {
	if (text.length <= maxLength) return text;
	const lastSpace = text.lastIndexOf(' ', maxLength);
	if (lastSpace > 0) return `${text.slice(0, lastSpace)}…`;
	// No space fits inside the limit — a single token straddles it (a long URL, say). Overshoot
	// to the next boundary rather than severing the token: slightly over-length beats mangled,
	// the same trade this module makes for an over-length authored description. Only when the
	// text has no whitespace at all is there nothing better to do than a hard cut.
	const nextSpace = text.indexOf(' ', maxLength);
	return `${nextSpace > 0 ? text.slice(0, nextSpace) : text.slice(0, maxLength)}…`;
}

/**
 * Resolve a page's meta / `og:` / `twitter:description`.
 *
 * An editor-authored description is returned VERBATIM, even past the 150 chars the Payload
 * admin's length indicator flags — search engines truncate the snippet themselves, by pixel
 * width, and `og:description` has more room again on LinkedIn/Slack. Clamping here would cut
 * a sentence the author never saw cut.
 *
 * The FALLBACK is truncated, because it isn't authored: `generateDescription` in the SEO
 * plugin only runs when someone clicks Auto-generate, so a page nobody ran it on has no
 * description at all, and an untruncated body would put a whole article in the tag.
 *
 * `excerpt` (Updates only) sits between the two: it is editor-written, so it is also returned
 * verbatim, but it loses to an explicit SEO description. Pages have no excerpt and skip it.
 *
 * Returns `undefined` when there is no text at all — `Seo.svelte` omits the tags entirely
 * rather than emitting empty ones.
 */
export function resolveMetaDescription(page: {
	meta?: { description?: string | null } | null;
	excerpt?: string | null;
	content?: { root?: { children?: unknown[] } } | null;
}): string | undefined {
	const authored = page.meta?.description?.trim() || page.excerpt?.trim();
	if (authored) return authored;
	const fallback = lexicalToPlainText(page.content);
	return fallback ? truncateOnWordBoundary(fallback, 150) : undefined;
}

/**
 * `WebPage` JSON-LD for a generic Payload page template — shared by every template that has no
 * more specific schema.org type of its own (see `Seo.svelte`'s `jsonLd` prop).
 */
export function webPageJsonLd(
	page: {
		title: string;
		meta?: { title?: string | null; description?: string | null } | null;
		content?: { root?: { children?: unknown[] } } | null;
	},
	pathname: string
) {
	return {
		'@context': 'https://schema.org',
		'@type': 'WebPage',
		name: resolvePageTitle(page),
		// Shares `resolveMetaDescription` with the `<meta>` tags on purpose — a page with no
		// authored description would otherwise be described in one surface and not the other.
		description: resolveMetaDescription(page),
		url: resolveCanonicalUrl(pathname)
	};
}

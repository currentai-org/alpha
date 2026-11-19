// The schemes a rendered link may carry. Anything else, `javascript:` and `vbscript:` included, renders
// as text. A denylist of bad schemes lost to `java\tscript:`.
const ALLOWED_HREF_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * The URL as the browser will resolve it: the WHATWG parser drops ASCII tab and newline anywhere and
 * leading/trailing C0 controls and spaces, so the scheme check has to look at the same string.
 */
export function normalizeUrl(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/[\t\n\r]/g, "").replace(/^[\u0000- ]+|[\u0000- ]+$/g, "");
}

/** The scheme the browser will read from `url`, lowercased, or null for a relative URL. */
function urlScheme(url: string): string | null {
	const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
	return match ? match[1].toLowerCase() : null;
}

/** An inline image, video or audio payload, which only an image source may carry. */
const INLINE_MEDIA_URL = /^(data:(image|video|audio)\/|blob:)/i;

/**
 * The href a rendered link may carry, or undefined when its scheme is not http, https or mailto.
 * Every link the app renders from model output or third-party metadata goes through this, citation
 * markers and source lists included.
 */
export function sanitizeHref(href?: string | null, { media = false } = {}): string | undefined {
	if (!href) return undefined;
	const url = normalizeUrl(href).replace(/>$/, "");
	if (!url) return undefined;
	if (media && INLINE_MEDIA_URL.test(url)) return url;
	const scheme = urlScheme(url);
	if (scheme !== null && !ALLOWED_HREF_SCHEMES.has(scheme)) return undefined;
	return url;
}

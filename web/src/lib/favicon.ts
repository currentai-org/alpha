/**
 * Site icons for URLs we show: a source the chat retrieved, a link someone pasted into the composer.
 *
 * The browser only ever asks our own origin (`/api/favicon?host=…`). That route asks one fixed
 * icon service for the host, so the visitor's browser never contacts the site itself just because
 * its link appeared on screen, and our server never resolves a hostname it was handed.
 *
 * Only the hostname crosses that boundary, normalized here so one site maps to one cached icon.
 */

// One DNS label: letters, digits and inner hyphens, at most 63 characters (punycode included).
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The host whose icon represents `url`, or null when there is none worth asking for: not an
 * http(s) URL, an IP literal, `localhost`, or a single-label name.
 */
export function faviconHost(url: string | null | undefined): string | null {
	if (!url) return null;
	let parsed: URL;
	try {
		parsed = new URL(url.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
	return normalizeFaviconHost(parsed.hostname);
}

/** Validates and normalizes a bare hostname; the route runs its query parameter through this too. */
export function normalizeFaviconHost(hostname: string | null | undefined): string | null {
	if (!hostname) return null;
	const host = hostname
		.toLowerCase()
		.replace(/\.$/, '')
		.replace(/^www\./, '');
	if (host.length > 253) return null;
	const labels = host.split('.');
	if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
	// The last label of a real name is never all digits, so this rejects every IPv4 literal.
	if (/^\d+$/.test(labels[labels.length - 1])) return null;
	return host;
}

/** Our own icon, for links to pages on this site. */
const OWN_ICON = '/favicon.svg';

/**
 * Same-origin image URL for `url`'s site icon: our own icon for a path on this site, the proxied
 * icon for an external page, or null when `faviconHost` has none.
 */
export function faviconSrc(url: string | null | undefined): string | null {
	const trimmed = url?.trim() ?? '';
	if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return OWN_ICON;
	const host = faviconHost(trimmed);
	return host ? `/api/favicon?${new URLSearchParams({ host })}` : null;
}

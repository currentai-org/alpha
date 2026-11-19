// The origin a CSP source list may name for a configured URL, shared by svelte.config.js. A URL that
// is unset, blank, unparsable or not http(s) yields nothing, so the directive leaves it out rather
// than carrying a broken source: `new URL("cms.example.org")` throws, and an opaque URL such as
// `foo:bar` parses with the origin "null", which a browser reads as a host named null.
// PUBLIC_CMS_PAYLOAD_URL is the case that motivates it: the chat surface and the public snapshot
// boot without a CMS (config/env-manifest.mjs, `bootReq`), and their CSP must then name no CMS.

/**
 * @param {string | undefined} url
 * @returns {string | undefined}
 */
export function originOf(url) {
	const raw = url?.trim();
	if (!raw) return undefined;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
		return parsed.origin;
	} catch {
		return undefined;
	}
}

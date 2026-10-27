/**
 * The icon font's URL exactly as `icons.generated.css` requests it, content-hash query included, so
 * a preload of it is the same request the stylesheet makes rather than a second download. Read from
 * the generated file so a regenerated font can't leave a stale hash here. Throws when the file no
 * longer names a woff2, since a preload pointing nowhere would fail silently.
 */
export function iconFontUrlFrom(css: string): string {
	const url = /url\('([^']+\.woff2[^']*)'\)/.exec(css)?.[1];
	if (!url)
		throw new Error('icons.generated.css no longer names a woff2 font; update iconFontUrlFrom');
	return url;
}

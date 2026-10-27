export function isExternalHref(href: string): boolean {
	return /^https?:\/\//i.test(href);
}

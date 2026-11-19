/**
 * The browser's own chrome around the chat: the address bar and toolbar tint on mobile Safari and
 * Chrome. Safari 26 tints from the page's root background, and older Safari and Chrome read the
 * `theme-color` meta, so both follow the chat window's ground. `<html>` stays light everywhere else
 * (app.css), and `restore` puts both back when the chat unmounts.
 */
export function paintBrowserChrome(doc: Document, ground: string, dark: boolean): () => void {
	const root = doc.documentElement;
	const before = { background: root.style.backgroundColor, scheme: root.style.colorScheme };
	const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	const beforeMeta = meta?.getAttribute('content') ?? null;

	root.style.backgroundColor = ground;
	root.style.colorScheme = dark ? 'dark' : 'light';
	meta?.setAttribute('content', ground);

	return () => {
		root.style.backgroundColor = before.background;
		root.style.colorScheme = before.scheme;
		if (meta && beforeMeta !== null) meta.setAttribute('content', beforeMeta);
	};
}

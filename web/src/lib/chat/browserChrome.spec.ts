import { describe, expect, it } from 'vitest';
import { paintBrowserChrome } from './browserChrome';

function fakeDocument(metaContent: string | null) {
	const attrs = new Map<string, string>();
	if (metaContent !== null) attrs.set('content', metaContent);
	const meta =
		metaContent === null
			? null
			: {
					getAttribute: (k: string) => attrs.get(k) ?? null,
					setAttribute: (k: string, v: string) => attrs.set(k, v)
				};
	const style = { backgroundColor: '', colorScheme: '' };
	const doc = { documentElement: { style }, querySelector: () => meta } as unknown as Document;
	return { doc, style, content: () => attrs.get('content') };
}

describe('paintBrowserChrome', () => {
	it('paints the root background, color-scheme and theme-color with the dark chat ground', () => {
		const { doc, style, content } = fakeDocument('#e8e4de');
		paintBrowserChrome(doc, 'rgb(20, 22, 26)', true);
		expect(style.backgroundColor).toBe('rgb(20, 22, 26)');
		expect(style.colorScheme).toBe('dark');
		expect(content()).toBe('rgb(20, 22, 26)');
	});

	it('restores the light site chrome when the chat unmounts', () => {
		const { doc, style, content } = fakeDocument('#e8e4de');
		const restore = paintBrowserChrome(doc, 'rgb(20, 22, 26)', true);
		restore();
		expect(style.backgroundColor).toBe('');
		expect(style.colorScheme).toBe('');
		expect(content()).toBe('#e8e4de');
	});

	it('still paints the root background when the page has no theme-color meta', () => {
		const { doc, style } = fakeDocument(null);
		paintBrowserChrome(doc, 'rgb(250, 250, 250)', false);
		expect(style.backgroundColor).toBe('rgb(250, 250, 250)');
		expect(style.colorScheme).toBe('light');
	});
});

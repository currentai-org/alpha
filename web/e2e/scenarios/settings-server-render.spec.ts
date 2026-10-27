// e2e-product: @chat
// e2e-area: @settings
import { test, expect } from './helpers/test';

// The settings group used to set `ssr = false`, so a reload, a typed URL or a return from an
// OAuth provider got an empty shell (about 2 KB, no visible text) and painted nothing for 1-2s until the
// client bundle loaded (CUR-908). The journey critique measured that blank on A3's "Forget everything" walk and
// A4's Appearance reload on every graded run. Four pages were switched back one ticket at a time
// (CUR-2009, CUR-2146, CUR-1975, CUR-1769) while the group default stayed.
//
// This reads the server's own HTML, before any script runs, so a page that slips back to client-only
// fails here whatever the browser does afterwards. Each page is one a guest can open with no flag.
const PAGES = [
	{ path: '/chat/settings/appearance', text: 'Theme' },
	{ path: '/chat/settings/personalization', text: 'Alpha instructions' },
	{ path: '/chat/settings/data', text: 'Forget everything' }
] as const;

for (const { path, text } of PAGES) {
	test(`${path} sends its own content in the server HTML, so a reload paints without waiting for the bundle, and marks it uncacheable`, async ({
		request
	}) => {
		const res = await request.get(path, { maxRedirects: 0 });
		expect(res.status(), `${path} answered ${res.status()}`).toBe(200);
		const html = await res.text();
		expect(
			html,
			`${path}'s server HTML (${html.length} bytes) does not contain "${text}", so a fresh open paints nothing until the client bundle loads`
		).toContain(text);
		expect(
			res.headers()['cache-control'] ?? '',
			`${path} carries the visitor's session and settings, so no shared cache may keep it`
		).toContain('no-store');
	});
}

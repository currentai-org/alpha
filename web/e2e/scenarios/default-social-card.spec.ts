// e2e-product: @site
import { test, expect } from './helpers/test';

// The site's default share image, used by every page that sets no `meta.image` in Payload
// (production's homepage among them), is the homepage card, a JPEG. `og:image` is absolute and built
// from PUBLIC_ORIGIN, which on a PR preview is develop's origin, so a page's tag can name a file this
// deployment ships before develop does. The check therefore asks the deployment under test for the
// file itself. (CUR-2991, CUR-4690)

/** Width and height from a JPEG's SOF segment: any of SOF0–SOF15 bar DHT (C4), JPG (C8) and DAC (CC). */
function jpegSize(jpg: Buffer): { width: number; height: number } | null {
	let i = 2; // past the SOI marker
	while (i + 9 < jpg.length) {
		if (jpg[i] !== 0xff) return null;
		const marker = jpg[i + 1];
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			return { width: jpg.readUInt16BE(i + 7), height: jpg.readUInt16BE(i + 5) };
		}
		i += 2 + jpg.readUInt16BE(i + 2);
	}
	return null;
}

test(
	'the default share image is served as a 1200 x 630 JPEG',
	{ tag: ['@CUR-2991', '@CUR-4690'] },
	async ({ request }) => {
		const res = await request.get('/ai-potluck-og-home.jpg');
		expect(res.status(), 'the default share image does not load').toBe(200);
		expect(res.headers()['content-type']).toBe('image/jpeg');
		expect(jpegSize(await res.body())).toEqual({ width: 1200, height: 630 });
	}
);

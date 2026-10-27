import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { iconFontUrlFrom } from './fontUrl';

const generatedCss = readFileSync(new URL('./icons.generated.css', import.meta.url), 'utf8');

describe('icon font preload URL (CUR-2269)', () => {
	it('names a font file that static/ actually serves, with the hash query the stylesheet uses', () => {
		const [path, query] = iconFontUrlFrom(generatedCss).split('?');
		expect(
			query,
			'the preload must carry the cache-busting query or it is a second request'
		).toBeTruthy();
		const onDisk = fileURLToPath(new URL(`../../../static${path}`, import.meta.url));
		expect(existsSync(onDisk), `${onDisk} does not exist`).toBe(true);
	});

	it('fails loud when the generated CSS no longer names a woff2, instead of preloading nothing', () => {
		expect(() => iconFontUrlFrom("@font-face { src: url('/x.ttf') }")).toThrow(
			/no longer names a woff2/
		);
	});
});

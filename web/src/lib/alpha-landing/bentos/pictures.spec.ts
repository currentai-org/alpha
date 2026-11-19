import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { locales } from '$lib/i18n/locales';
import { FEATURE_PICTURES, featurePictureSrc, type FeaturePicture } from './pictures';

const names = Object.keys(FEATURE_PICTURES) as FeaturePicture[];
const staticFile = (src: string) => join(process.cwd(), 'static', src);

describe('the /alpha feature pictures', () => {
	it.each(locales.map((locale) => [locale]))('has every picture captured in %s', (locale) => {
		for (const name of names) {
			const src = featurePictureSrc(name, locale);
			expect(src).toBe(`/alpha-features/${name}.${locale}.webp`);
			expect(existsSync(staticFile(src)), src).toBe(true);
		}
	});

	it('shows the English picture for a locale with no capture', () => {
		expect(featurePictureSrc('xray', 'pt')).toBe('/alpha-features/xray.en.webp');
	});
});

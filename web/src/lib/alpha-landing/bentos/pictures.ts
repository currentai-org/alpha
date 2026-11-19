/**
 * The feature cards on /alpha that show a picture of an Alpha feature rather than running it. Each
 * picture is the card's scene (everything under its heading) captured from the live page in every
 * locale, saved as `static/alpha-features/<name>.<locale>.webp` at twice its CSS size.
 * `README.md` ("Feature pictures") says how to capture them again.
 */

const PICTURE_LOCALES = ['en', 'de', 'es', 'fr'] as const;
type PictureLocale = (typeof PICTURE_LOCALES)[number];

/** CSS size of each scene as captured (English; the other locales differ by a few pixels at most). */
export const FEATURE_PICTURES = {
	language: { width: 661, height: 384 },
	data: { width: 610, height: 380 },
	footprint: { width: 610, height: 398 },
	model: { width: 401, height: 461 },
	xray: { width: 661, height: 546 }
} as const;

export type FeaturePicture = keyof typeof FEATURE_PICTURES;

/** The picture's URL for a locale, falling back to English for a locale with no capture. */
export function featurePictureSrc(name: FeaturePicture, locale: string): string {
	const lang = (PICTURE_LOCALES as readonly string[]).includes(locale)
		? (locale as PictureLocale)
		: 'en';
	return `/alpha-features/${name}.${lang}.webp`;
}

import type { OpennessBucket } from '$lib/types/category';

/**
 * The gap map's one vocabulary for a product's score level. The legend, the "How to read the map"
 * dialog, row captions, tooltips and the side panels all read from here, so the three levels are
 * never called anything else (CUR-624).
 *
 * Two terms, two levels: "maturity stage" belongs to a category, "product score" to a product.
 * Changing a word here changes it everywhere.
 */
export type ScoreLevel = 'leading' | 'strong' | 'outline';

/** Lowercase, for running text ("5 leading, 1 strong"). */
export const SCORE_LEVEL_WORDS: Record<ScoreLevel, string> = {
	leading: 'leading',
	strong: 'strong',
	outline: 'available'
};

/** Sentence case, for a label that stands on its own ("Strong · 4.0"). */
export const SCORE_LEVEL_LABELS: Record<ScoreLevel, string> = {
	leading: 'Leading',
	strong: 'Strong',
	outline: 'Available'
};

export const SCORE_LEVEL_RANGES: Record<ScoreLevel, string> = {
	leading: '4.5 or more',
	strong: '4.0 to 4.4',
	outline: 'below 4.0'
};

export const PRODUCT_SCORE_LABEL = 'Product score';
export const MATURITY_STAGE_LABEL = 'Maturity stage';

export const OPENNESS_LABELS: Record<Extract<OpennessBucket, 'open' | 'open-ish'>, string> = {
	open: 'Open source',
	'open-ish': 'Open-ish'
};

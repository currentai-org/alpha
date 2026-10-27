import { LEADING_MIN, STRONG_MIN } from '$lib/constants/maturity';
import type { ProductTier } from '$lib/types/category';
import type { ScoreLevel } from '$lib/constants/vocabulary';

/**
 * The product's overall score, preferring the current payload key. os-ai-map#318 renamed
 * `maturity` to `overall_score` and publishes both for one release; this is the single place
 * that knows about the old name, so retiring it is a one-line change here.
 */
export function productScore(p: {
	overall_score?: number | null;
	maturity?: number | null;
}): number | null {
	return p.overall_score ?? p.maturity ?? null;
}

/**
 * Fill levels on the map: two tiers. Finer bands would place the same grades in different bands
 * purely because categories weight the two axes differently; two tiers mean the same thing in every
 * category.
 */
export type MaturityVisualLevel = 1 | 2;

/** The product's tier, preferring the payload's own field over re-deriving it from the score. */
export function getProductTier(
	score: number | null | undefined,
	tier?: ProductTier | null
): ProductTier | null {
	if (tier) return tier;
	if (score == null) return null;
	if (score >= LEADING_MIN) return 'leading';
	if (score >= STRONG_MIN) return 'strong';
	return null;
}

/** A product's score level: its tier, or `outline` for a product below Strong or unscored. */
export function getScoreLevel(
	score: number | null | undefined,
	tier?: ProductTier | null
): ScoreLevel {
	return getProductTier(score, tier) ?? 'outline';
}

export function getMaturityVisualLevel(
	score: number,
	tier?: ProductTier | null
): MaturityVisualLevel {
	return getProductTier(score, tier) === 'leading' ? 1 : 2;
}

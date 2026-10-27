import type { OpennessBucket, ProductTier } from '$lib/types/category';

/**
 * Product score tiers, mirroring _LEADING_MIN / _STRONG_MIN in os-ai-map's build/serialize.py.
 *
 * Both graded axes are whole numbers 1-5, so the Leading bar can only be cleared by a 5 on one
 * axis paired with a strong partner. A product graded 4 and 4 blends to exactly 4.0 and is
 * Strong. The payload now ships a `tier` field carrying this directly; these constants stay so
 * the app can derive a tier from a payload synced before os-ai-map#318.
 */
export const LEADING_MIN = 4.5;
export const STRONG_MIN = 4;

/**
 * The floor for a product to render filled on the map, rather than outlined.
 * Same value as STRONG_MIN — a product is shown when it reaches a named tier.
 */
export const MATURE_THRESHOLD = STRONG_MIN;

/** Representative scores for legend — one per visual level */
export const LEGEND_MATURITY_SAMPLES: ReadonlyArray<{
	maturity: number;
	bucket: OpennessBucket;
	tier: ProductTier;
}> = [
	{ maturity: LEADING_MIN, bucket: 'open', tier: 'leading' },
	{ maturity: STRONG_MIN, bucket: 'open', tier: 'strong' }
];

/** Solid maturity used for openness legend keys (bucket shape only, not maturity-encoded) */
export const LEGEND_OPENNESS_MATURITY = 5;

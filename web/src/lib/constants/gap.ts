import type { GapType } from '$lib/types/category';

export const GAP_META: Record<GapType, { label: string; letter: string; ariaLabel: string }> = {
	void: { label: 'Void', letter: 'v', ariaLabel: 'Void gap' },
	capability: { label: 'Capability', letter: 'c', ariaLabel: 'Capability gap' },
	adoption: { label: 'Adoption', letter: 'a', ariaLabel: 'Adoption gap' },
	resiliency: { label: 'Resiliency', letter: 'r', ariaLabel: 'Resiliency gap' },
	// Transitional alias for `resiliency`, kept so a payload built before the rename still
	// renders instead of throwing on a GAP_META miss. It deliberately carries the SAME letter
	// and label, so which key the data sends is invisible to a reader. Remove it, and the
	// GAP_KEY_ALIASES entry below, once no published dataset emits `depth`.
	depth: { label: 'Resiliency', letter: 'r', ariaLabel: 'Resiliency gap' },
	openness: { label: 'Openness', letter: 'o', ariaLabel: 'Openness gap' },
	// 'd' matches the label; the resiliency gap takes 'r'.
	disclosure: { label: 'Disclosure', letter: 'd', ariaLabel: 'Disclosure gap' }
};

// Gap types shown in the legend. `void` is intentionally omitted: no category
// currently carries it. It stays in GapType / GAP_META so a void gap still renders
// (and can be re-added here) if the data ever produces one.
// Old payload key -> current key, for datasets published either side of a rename. Only the
// current key is ever rendered; this exists so a description recorded under the old name is
// still found. Drop an entry once no published dataset carries the old key.
export const GAP_KEY_ALIASES: Partial<Record<GapType, GapType>> = {
	resiliency: 'depth'
};

export const GAP_LEGEND_ORDER: GapType[] = [
	'capability',
	'adoption',
	'resiliency',
	'openness',
	'disclosure'
];

export const OPENNESS_LEGEND_DESCRIPTION_BASE =
	'Every product is assessed with an openness score, and is typed as Open Source, Open-ish or closed.';
const OPENNESS_LEGEND_MAP_ONLY_SUFFIX = 'This map only shows the first 2 types.';
/** The gap map's full sentence; the dataset shows every type and drops the suffix. */
export const OPENNESS_LEGEND_DESCRIPTION = `${OPENNESS_LEGEND_DESCRIPTION_BASE} ${OPENNESS_LEGEND_MAP_ONLY_SUFFIX}`;

export const MATURITY_LEGEND_DESCRIPTION =
	'The maturity stage looks at the fully open options within a category. The higher the stage, the more the category can rely on fully open options.';
export const MATURITY_LEGEND_SAMPLES = [
	{ stage: 1, label: 'Fully open products are absent' },
	{ stage: 5, label: 'Mature Open Ecosystem' }
] as const;

export const SCORE_LEGEND_DESCRIPTION =
	'Every product carries a score on a 1–5 scale, blending capability and adoption. Products scoring 4.5 or above are leading, those from 4.0 to 4.5 are strong, and everything below is shown outlined.';

export const GAPS_LEGEND_DESCRIPTION =
	'Gaps are indicators of where a category should improve. A category can have multiple gaps, and are set by clear rules';

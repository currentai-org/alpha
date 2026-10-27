// `depth` is the old name for `resiliency` and is accepted only until the data stops
// emitting it; see GAP_META. Both are listed so a payload from either side of the
// rename type-checks and renders.
export type GapType =
	'void' | 'capability' | 'adoption' | 'resiliency' | 'depth' | 'openness' | 'disclosure';

/** Product score band. Derived from the overall score; `null` below the Strong floor. */
export type ProductTier = 'leading' | 'strong';

// Layer ids are data-driven (sourced from the dataset's `layer_order`).
export type Layer = string;

export type OpennessBucket = 'open' | 'open-ish' | 'closed' | 'empty';

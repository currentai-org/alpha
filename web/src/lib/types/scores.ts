export interface ScoreSource {
	url: string;
	accessed: string;
	shows: string;
}

import type { OpennessBucket, ProductTier } from '$lib/types/category';

export interface DimensionScore {
	score?: number | null; // capability uses `score`; adoption uses `level`
	level?: number;
	confidence: string;
	note: string;
	sources: ScoreSource[];
	// capability/openness/adoption-specific fields...
}

export interface ProductFreshness {
	date: string; // YYYY-MM-DD
	// `verified` = the score file carries last_verified. `commit` = the fallback, the score
	// file's git commit date. The page labels these differently on purpose; see
	// os-ai-map/docs/guides/freshness.md. `partial` = verified on this date with the named
	// axes held open until a later observation run settles them.
	basis: 'verified' | 'partial' | 'commit';
	unconfirmed_axes?: string[];
}

export interface OrganizationRecord {
	slug: string;
	display_name: string;
	type: string;
	homepage: string;
	github: string[];
	/** ISO 3166-1 alpha-2 from payload contract 2, free text before it; render via countryName(). */
	country: string;
	/** Empty for an org that only stewards products (contract 2); allOrgSlugs() leaves it out. */
	products: string[];
}

export interface ScoredProduct {
	product: string;
	org: string;
	type: 'software' | 'model' | 'dataset';
	description: string;
	// `level` is nullable in the real payload — a fifth of a percent of products carry no
	// adoption level at all, the same way `capability.score` can be absent. Typed honestly so
	// the "not assessed" honesty rule keeps firing: with a non-optional `number` here, an editor
	// trusting the signature would drop the `?? null` at the call site and silently render an
	// absent adoption level as a verdict.
	adoption: DimensionScore & {
		level: number | null;
		reach: string;
		signal_type: string;
	};
	capability: DimensionScore & {
		score: number | null;
		basis: string;
		value: string | null;
	};
	openness: DimensionScore & {
		score: number;
		class: string;
		components: string;
		bucket: OpennessBucket;
	};
	// The blended capability/adoption score, 1..5; absent for unscored products. `maturity` is
	// the old name for the same number — os-ai-map#318 renamed it to `overall_score` and
	// publishes both for one release. Read via productScore(), which prefers the new key.
	overall_score?: number | null;
	maturity?: number;
	tier?: ProductTier | null; // 'leading' | 'strong'; null below the Strong floor
	slug: string;
	org_slug: string;
	freshness: ProductFreshness;
	flags?: string[];
	version_note: string;
}

export interface DatasetDescriptions {
	stages: Record<string, string>;
	gaps: Record<string, string>;
	categories: Record<string, string>;
}

export interface Dataset {
	products: FlatProductRow[];
	descriptions: DatasetDescriptions;
	layerOrder: string[]; // layer (tab/section) display order, from the dataset
	organizations: Record<string, OrganizationRecord>;
	aliases: { products: Record<string, string>; organizations: Record<string, string> };
}

export interface FlatProductRow extends ScoredProduct {
	id: string; // generated slug
	categoryId: string;
	categoryLabel: string;
	categoryDescription: string;
	categoryLayerLabel: string; // human-readable layer label, e.g. "Model components"
	categoryLayerId: string; // stable layer id, e.g. "model_components"
	categoryGaps: string[];
	categoryStage: { name: string; num: number };
}

export interface GapMapCategory {
	label: string;
	arc: string; // human-readable layer label
	layer: string; // stable layer id
	stage: { num: number; name: string };
	gaps: string[];
	products: ScoredProduct[];
}

/** Where the dataset version came from: the publish run itself, or the static JSON fallback. */
export type DatasetVersionSource = 'db' | 'static-json';

/**
 * The whole gap map, assembled from the os-ai-map Neon schema by $lib/server/gapMap. Same shape
 * as static/data/notebook_data.json, which /roadmap-v2 still reads.
 */
export interface GapMapPayload {
	categories: Record<string, GapMapCategory>;
	order: string[];
	layer_order: string[];
	organizations: Record<string, OrganizationRecord>;
	aliases: { products: Record<string, string>; organizations: Record<string, string> };
	descriptions: DatasetDescriptions;
	long_tail: {
		counts: Record<string, number>;
		top: { name: string; type: string; usage_label: string; description: string }[];
	};
	n_total: number;
	generated: string;
	released: string | null;
	version: string;
	version_source: DatasetVersionSource;
	contract: number;
	run_id: string;
	source_git_sha: string | null;
}

/** The headline figures a page shows without needing the whole dataset. */
export interface GapMapMeta {
	version: string;
	version_label: string; // "V0.3": patch dropped, a badge names a release, not a fix
	version_source: DatasetVersionSource;
	released: string | null;
	generated: string;
	contract: number;
	run_id: string;
	source_git_sha: string | null;
	scored_products: number;
	total_products: number | null;
}

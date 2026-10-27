import type { FlatProductRow } from '$lib/types/scores';
import type { Layer } from './category';

export interface CategoryGroup {
	layerLabel: string; // human-readable layer label
	layerId: string; // stable layer id
	categoryId: string;
	counts: { open: number; openish: number; closed: number };
	description: string;
	gaps: string[];
	label: string;
	products: FlatProductRow[];
	stage: {
		name: string;
		num: number;
	};
}

export interface LayerGroup {
	layerId: Layer; // stable layer id (grouping/order key)
	layerLabel: string; // human-readable layer label (display)
	categories: CategoryGroup[];
}

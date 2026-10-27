import { GAP_META } from '$lib/constants/gap';
import type { GapType } from '$lib/types/category';

export function isGapType(value: string): value is GapType {
	return value in GAP_META;
}

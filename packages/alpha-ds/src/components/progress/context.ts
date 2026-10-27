import { getContext, setContext } from 'svelte';

export interface RangeState {
	readonly value: number | null;
	readonly min: number;
	readonly max: number;
	/** 0–100, or null while indeterminate. */
	readonly percent: number | null;
	readonly formatted: string;
	readonly labelId: string;
}

const KEY = Symbol('alpha-ds.range');
export const setRange = (s: RangeState) => setContext(KEY, s);
export const getRange = () => getContext<RangeState>(KEY);

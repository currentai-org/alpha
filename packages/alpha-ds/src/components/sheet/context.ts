import { getContext, setContext } from 'svelte';

export interface SheetContext {
	close(): void;
}
const KEY = Symbol('alpha-ds.sheet');
export const setSheet = (ctx: SheetContext) => setContext(KEY, ctx);
export const getSheet = () => getContext<SheetContext | undefined>(KEY);

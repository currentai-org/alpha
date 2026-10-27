import { getContext, setContext } from 'svelte';

export interface ComposerAccessoryContext {
	/** The open panel's value, or null. One panel at a time. */
	readonly open: string | null;
	readonly baseId: string;
	toggle(value: string): void;
	close(): void;
}

const KEY = Symbol('alpha-ds.composer-accessory');

export const setComposerAccessory = (ctx: ComposerAccessoryContext) => setContext(KEY, ctx);

export function getComposerAccessory(): ComposerAccessoryContext {
	const ctx = getContext<ComposerAccessoryContext | undefined>(KEY);
	if (!ctx) throw new Error('ComposerAccessory parts must be inside <ComposerAccessory.Root>.');
	return ctx;
}

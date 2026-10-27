import { getContext, setContext } from 'svelte';

export interface ComposerContext {
	readonly value: string;
	readonly disabled: boolean;
	readonly busy: boolean;
	readonly canSubmit: boolean;
	setValue(v: string): void;
	submit(): void;
	stop(): void;
	registerInput(el: HTMLTextAreaElement | null): void;
	focus(): void;
}

const KEY = Symbol('alpha-ds.composer');
export const setComposer = (ctx: ComposerContext) => setContext(KEY, ctx);
export const getComposer = () => getContext<ComposerContext>(KEY);

import { getContext, setContext } from 'svelte';
import { defaultAlphaLandingContent, type AlphaLandingContent } from './content';

const KEY = Symbol('alpha-landing-content');

export function setAlphaLandingContent(read: () => AlphaLandingContent): void {
	setContext(KEY, read);
}

/** A request/component scoped reader; live preview changes flow to all descendants. */
export function getAlphaLandingContent(): () => AlphaLandingContent {
	return getContext<() => AlphaLandingContent>(KEY) ?? (() => defaultAlphaLandingContent);
}

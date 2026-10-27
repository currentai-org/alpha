import { MediaQuery } from 'svelte/reactivity';

/** The breakpoint below which floating surfaces become sheets (matches Tailwind's `md`). */
export const COMPACT_QUERY = '(max-width: 767px)';

/**
 * Reactive "is this a phone-sized screen?" — `.current` is true below `md`. Use it to render a
 * `Sheet` on small screens and a Popover / Panel / Dialog otherwise.
 */
export function useCompact(): MediaQuery {
	return new MediaQuery(COMPACT_QUERY, false);
}

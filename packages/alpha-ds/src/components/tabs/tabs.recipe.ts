import { getContext } from 'svelte';
import { tv } from '../../internal/cn.ts';

/**
 * Tabs skin. `line` is the ruled strip with an ink bar under the selected tab; `segment` is a
 * segmented control (the toggle group's `segment` look) for a few peer views of one place.
 */
export const tabsListRecipe = tv({
	base: 'relative flex items-stretch',
	variants: {
		variant: {
			line: 'gap-0 border-b border-line-surface ui-vertical:flex-col ui-vertical:border-r ui-vertical:border-b-0',
			segment:
				'w-fit max-w-full flex-wrap gap-0.5 border border-line-surface bg-surface-raised p-0.5 rounded-sharp ui-vertical:flex-col'
		}
	},
	defaultVariants: { variant: 'line' }
});

export const tabsTabRecipe = tv({
	base: [
		'inline-flex items-center gap-2 type-cta transition-control',
		'ui-disabled:pointer-events-none ui-disabled:opacity-40',
		'[&_svg]:size-4'
	],
	variants: {
		variant: {
			line: [
				'relative -mb-px h-control-md border-b-2 border-transparent px-3 text-fg-3',
				'hover:text-fg-1 ui-selected:border-fg-1 ui-selected:text-fg-1',
				'ui-vertical:mr-[-1px] ui-vertical:mb-0 ui-vertical:border-r-2 ui-vertical:border-b-0'
			],
			segment:
				'h-control-sm shrink-0 px-3 text-fg-2 rounded-sharp hover:bg-tint-hover hover:text-fg-1 ui-selected:bg-fg-1 ui-selected:text-surface-1'
		}
	},
	defaultVariants: { variant: 'line' }
});

export type TabsVariant = 'line' | 'segment';

/** The variant the enclosing `Tabs.Root` chose. */
export function tabsVariant(): TabsVariant {
	return getContext<{ variant: TabsVariant } | undefined>('alpha-ds.tabs')?.variant ?? 'line';
}

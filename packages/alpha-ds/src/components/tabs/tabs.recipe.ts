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
				'relative -mb-px border-b-2 border-transparent px-3 text-fg-3',
				'hover:text-fg-1 ui-selected:border-fg-1 ui-selected:text-fg-1',
				'ui-vertical:mr-[-1px] ui-vertical:mb-0 ui-vertical:border-r-2 ui-vertical:border-b-0'
			],
			segment:
				'px-3 text-fg-2 rounded-sharp hover:bg-tint-hover hover:text-fg-1 ui-selected:bg-fg-1 ui-selected:text-surface-1'
		},
		// `wrap`: the label is a name someone chose (a bucket, a folder), so it keeps its own case and
		// wraps rather than being cut. The tab grows to fit and may shrink to the list's width.
		wrap: {
			false: '',
			true: 'h-auto max-w-full shrink py-1 text-left normal-case wrap-anywhere'
		}
	},
	compoundVariants: [
		{ variant: 'line', wrap: false, class: 'h-control-md' },
		{ variant: 'segment', wrap: false, class: 'h-control-sm shrink-0' },
		{ variant: 'line', wrap: true, class: 'min-h-control-md' },
		{ variant: 'segment', wrap: true, class: 'min-h-control-sm' }
	],
	defaultVariants: { variant: 'line', wrap: false }
});

export type TabsVariant = 'line' | 'segment';

/** The variant the enclosing `Tabs.Root` chose. */
export function tabsVariant(): TabsVariant {
	return getContext<{ variant: TabsVariant } | undefined>('alpha-ds.tabs')?.variant ?? 'line';
}

/** Whether the enclosing `Tabs.Root` asked its tabs to wrap long labels. */
export function tabsWrap(): boolean {
	return getContext<{ wrap?: boolean } | undefined>('alpha-ds.tabs')?.wrap ?? false;
}

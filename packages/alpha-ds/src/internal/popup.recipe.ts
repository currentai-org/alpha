/**
 * Shared skin for floating surfaces. Floating content sits on Background 3 ("anything that floats
 * above the main content"), so its rules step up to Border 3 and it establishes surface context 3
 * for whatever renders inside. Brutalist separation: a hard offset shadow, never a blur.
 */
import { tv } from './cn.ts';

export const popupRecipe = tv({
	base: 'z-popover border border-line-2 bg-surface-3 text-fg-1 shadow-popover rounded-popup outline-none motion-popup',
	variants: {
		size: {
			auto: '',
			sm: 'w-56',
			md: 'w-72',
			lg: 'w-96'
		},
		padded: { true: 'p-3', false: '' }
	},
	defaultVariants: { size: 'auto', padded: true }
});

/** Rows inside Menu / Select popups. */
export const itemRecipe = tv({
	base: [
		'relative flex min-h-control-sm w-full cursor-default items-center gap-2 px-2 py-1 text-left type-body text-fg-2 outline-none select-none rounded-sharp',
		'ui-highlighted:bg-tint-hover ui-highlighted:text-fg-1 ui-disabled:pointer-events-none ui-disabled:opacity-40',
		'[&_svg]:size-4 [&_svg]:shrink-0'
	],
	variants: {
		tone: {
			default: '',
			/** Destructive row: label stays Text 1, only the icon takes Accent 2 (spec). */
			destructive: 'text-fg-1 [&_svg]:text-accent-2',
			/** A menu's one primary action, drawn like a primary Button (e.g. the demo's Sign up). */
			cta: 'min-h-control-lg justify-center bg-fg-1 font-medium text-surface-1 ui-highlighted:bg-fg-1 ui-highlighted:text-surface-1 ui-highlighted:opacity-85'
		}
	},
	defaultVariants: { tone: 'default' }
});

export const arrowClass = 'text-line-3 [&_svg]:fill-surface-3 [&_svg]:stroke-line-3';

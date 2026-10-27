/**
 * Button skin. Every visual decision for Button (and for every trigger part that renders as a
 * button — Dialog.Trigger, Popover.Trigger, Menu.Trigger…) lives in this one recipe.
 *
 * Spec (src/lib/chat/design-system.md §3):
 *  - Sharp by default; `pill` only for small in-chat CTAs (send, toggle pills).
 *  - Bordered buttons rest ONE TIER UP from the surface behind them (`bg-surface-raised`, which the
 *    surface context resolves), never transparent. Hover layers an ink tint on top.
 *  - Hover/active shift text + icon toward Text 1. Disabled is a flat opacity-40.
 *  - Accent fill is icon-button scale only (send, XRAY close) — `accent` is icon sizes only.
 *  - Destructive looks exactly like secondary; only the icon takes Accent 2.
 *  - Labels are left-aligned, even when they wrap.
 */
import { tv, type VariantProps } from '../../internal/cn.ts';

export const buttonRecipe = tv({
	base: [
		'relative inline-flex shrink-0 items-center justify-start gap-2 text-left whitespace-nowrap select-none',
		'type-cta rounded-sharp border border-transparent transition-control',
		'ui-disabled:pointer-events-none ui-disabled:opacity-40',
		'[&_svg]:pointer-events-none [&_svg]:shrink-0'
	],
	variants: {
		variant: {
			/** The one labelled primary action — solid ink, brutalist. */
			primary: 'bg-fg-1 text-surface-1 hover:opacity-85 active:opacity-75',
			/** Bordered. Default for everything else that is labelled. */
			secondary:
				'border-line-surface bg-surface-raised text-fg-2 hover:text-fg-1 hover:tint-hover active:tint-active ui-open:text-fg-1 ui-open:tint-active',
			/** Nav / utility — no fill at rest; a tint tile appears on hover (spec §5). */
			ghost:
				'bg-transparent text-fg-2 hover:bg-tint-hover hover:text-fg-1 active:bg-tint-active ui-open:bg-tint-active ui-open:text-fg-1 ui-pressed:bg-tint-active ui-pressed:text-fg-1 ui-selected:bg-tint-hover ui-selected:text-fg-1',
			/** Bordered, identical to secondary; only the icon carries Accent 2. */
			destructive:
				'border-line-surface bg-surface-raised text-fg-1 hover:tint-hover active:tint-active [&_svg]:text-accent-2',
			/** Accent-filled icon control (send, XRAY close). Icon sizes only. */
			accent: 'bg-accent-1 text-fg-on-accent hover:bg-accent-1-hover active:opacity-85',
			/** Inline text action. */
			link: 'h-auto! border-0 p-0! text-fg-1 underline decoration-line-3 underline-offset-4 hover:decoration-fg-1'
		},
		size: {
			xs: 'h-control-xs px-2 [&_svg]:size-3.5',
			sm: 'h-control-sm px-2.5 [&_svg]:size-4',
			md: 'h-control-md px-3 [&_svg]:size-4',
			lg: 'h-control-lg px-4 [&_svg]:size-5',
			'icon-xs': 'size-control-xs justify-center p-0 [&_svg]:size-3.5',
			'icon-sm': 'size-control-sm justify-center p-0 [&_svg]:size-4',
			icon: 'size-control-md justify-center p-0 [&_svg]:size-4',
			'icon-lg': 'size-control-lg justify-center p-0 [&_svg]:size-5'
		},
		shape: {
			sharp: 'rounded-sharp',
			pill: 'rounded-pill',
			field: 'rounded-field'
		},
		/** Stretch to the container (labels stay left-aligned). */
		/** Full width, content centred (sheets, dialogs, sign-in). */
		block: { true: 'w-full justify-center' },
		/**
		 * `upper` is the spec's CTA type (DM Mono, uppercase). `sentence` is Font 1 in sentence case —
		 * for controls that carry content rather than a command (a conversation title, a model name).
		 */
		casing: { upper: '', sentence: 'type-body normal-case' }
	},
	defaultVariants: { variant: 'secondary', size: 'md', shape: 'sharp', casing: 'upper' }
});

export type ButtonVariants = VariantProps<typeof buttonRecipe>;
export type ButtonVariant = NonNullable<ButtonVariants['variant']>;
export type ButtonSize = NonNullable<ButtonVariants['size']>;

export const isIconSize = (size: ButtonSize | undefined) => !!size && size.startsWith('icon');

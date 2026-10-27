import { tv } from '../../internal/cn.ts';

/** Pill: a small in-chat control, so Radius 3 (spec); rests one tier up from its surface. */
export const pillRecipe = tv({
	base: [
		'inline-flex h-control-sm max-w-full min-w-0 items-center gap-1.5 rounded-pill border px-3',
		'type-caption transition-control',
		'[&_svg]:size-3.5 [&_svg]:shrink-0',
		// Phones: a larger touch target.
		'max-md:h-9 max-md:gap-2 max-md:px-3.5 max-md:[&_svg]:size-4'
	],
	variants: {
		tone: {
			default: [
				'border-line-surface bg-surface-raised text-fg-2 hover:bg-tint-hover hover:text-fg-1',
				'aria-expanded:border-line-3 aria-expanded:text-fg-1'
			],
			/** XRAY: the normal pill with a cool mark, a hairline in the XRAY hue and a light sweep that
			 *  flares the hairline every few seconds, to draw the eye. */
			xray: [
				'xray-sweep border-xray-line bg-surface-raised text-fg-1 hover:bg-tint-hover [&_svg]:text-xray-glow',
				'aria-expanded:xray-halo'
			],
			/** Growth: a language Alpha is still learning — warm accent mark, text stays Text 1. */
			seed: [
				'border-line-surface bg-surface-raised text-fg-1 hover:bg-tint-hover [&_svg]:text-accent-1-text',
				'aria-expanded:border-line-3'
			]
		}
	},
	defaultVariants: { tone: 'default' }
});

/** Panel: in-flow, full composer width, Radius 2 to sit with the composer it belongs to. */
export const panelRecipe = tv({
	base: 'relative mb-2 flex w-full flex-col gap-3 rounded-field border p-4',
	variants: {
		tone: {
			default: 'border-line-surface bg-surface-raised',
			/** XRAY: the raised surface with a scanned header band and a cool hairline; content stays legible. */
			xray: 'border-xray-line bg-surface-raised text-fg-1 xray-band xray-halo',
			/** Growth: the raised surface with the seed band along the top; content stays legible. */
			seed: 'border-line-surface bg-surface-raised text-fg-1 seed-band'
		}
	},
	defaultVariants: { tone: 'default' }
});

/** Notice: one line on the composer's top edge, at its width; Radius 2 like the composer it belongs to. */
export const noticeRecipe = tv({
	base: [
		'mb-2 flex w-full items-center gap-2 rounded-field border border-line-surface bg-surface-raised',
		'py-2 pr-2 pl-3 type-small text-fg-1'
	]
});

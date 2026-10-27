import { tv, type VariantProps } from '../../internal/cn.ts';

/**
 * Toggle skin. Two shapes from the spec: `pill` is the in-chat toggle pill ("Web search",
 * "Read aloud" — Radius 3); `tile` is the square icon tile (tint 15% hover / 30% pressed).
 */
export const toggleRecipe = tv({
	base: [
		'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-fg-2 transition-control select-none',
		'hover:text-fg-1 ui-pressed:text-fg-1 ui-disabled:pointer-events-none ui-disabled:opacity-40',
		'[&_svg]:size-4 [&_svg]:shrink-0'
	],
	variants: {
		variant: {
			pill: 'h-control-sm rounded-pill border border-line-surface bg-surface-raised px-3 type-caption hover:tint-hover ui-pressed:border-fg-1 ui-pressed:tint-active',
			tile: 'size-control-md rounded-sharp hover:bg-tint-hover ui-pressed:bg-tint-active',
			segment:
				'h-control-sm rounded-sharp px-3 type-cta hover:bg-tint-hover ui-pressed:bg-fg-1 ui-pressed:text-surface-1'
		}
	},
	defaultVariants: { variant: 'pill' }
});

export type ToggleVariants = VariantProps<typeof toggleRecipe>;

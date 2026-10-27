import { tv, type VariantProps } from '../../internal/cn.ts';

/** Remix icons are filled outlines (`fill="currentColor"`) — size with width/height, colour with `color`. */
export const iconRecipe = tv({
	base: 'inline-block shrink-0',
	variants: {
		size: { xs: 'size-3', sm: 'size-3.5', md: 'size-4', lg: 'size-5', xl: 'size-6' },
		tone: {
			/** Inherit — the default; takes the surrounding text tier. */
			inherit: '',
			/** Text 1. Every line icon. */
			default: 'text-fg-1',
			muted: 'text-fg-3',
			/** Fill icons only: the one primary action in context. */
			accent: 'text-accent-1',
			/** Fill icons only: destructive / irreversible. */
			destructive: 'text-accent-2'
		}
	},
	defaultVariants: { size: 'md', tone: 'inherit' }
});

export type IconVariants = VariantProps<typeof iconRecipe>;

import { tv, type VariantProps } from '../../internal/cn.ts';

/**
 * Text field skin. Inputs are recessed content → always Background 2 (spec: "the message-input
 * bar and similar inset widgets should always resolve to this same token"), Border 2 rule,
 * sharp corners. Focus steps the rule up to Border 3 on top of the global focus ring.
 */
export const inputRecipe = tv({
	base: [
		'w-full min-w-0 border border-line-2 bg-surface-2 text-fg-1 rounded-sharp transition-control',
		'font-sans text-body placeholder:text-fg-3',
		'hover:border-line-3 focus-visible:border-line-3',
		'ui-invalid:border-accent-2',
		'ui-disabled:cursor-not-allowed ui-disabled:opacity-40',
		'file:mr-3 file:border-0 file:bg-transparent file:type-cta file:text-fg-2'
	],
	variants: {
		size: {
			sm: 'h-control-sm px-2 text-small',
			md: 'h-control-md px-3',
			lg: 'h-control-lg px-3 text-subhead'
		},
		/** `bare`: no box — for an input that IS the surface (command palettes, inline rename). */
		appearance: {
			field: '',
			bare: 'border-0 bg-transparent px-0 hover:border-0 focus-visible:outline-none',
			/**
			 * One-time codes: centred, monospaced, spaced digits. The placeholder clears while focused:
			 * an empty centred field puts the caret in the middle of it, so "000000" read as "000|000".
			 */
			code: 'text-center font-mono text-subhead tracking-[0.4em] focus:placeholder:text-transparent'
		}
	},
	defaultVariants: { size: 'md', appearance: 'field' }
});

export type InputVariants = VariantProps<typeof inputRecipe>;

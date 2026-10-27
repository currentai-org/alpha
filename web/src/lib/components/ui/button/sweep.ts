import type { ButtonVariant } from './button.svelte';

// The three colorways, each describing a button body's HOVER state: `blocks` is the wipe fill
// and `label` the text color it reveals. The chevron variants own these values (they double as
// the icon box's resting colors), and the plain rectangular variants borrow them from their
// chevron twin, so a plain button and its chevron counterpart animate to exactly the same place.
export const COLORWAYS = {
	dark: { blocks: 'bg-white', label: 'group-hover/button:text-dark-blue' },
	light: { blocks: 'bg-dark-blue', label: 'group-hover/button:text-white' },
	salmon: { blocks: 'bg-dark-blue', label: 'group-hover/button:text-salmon' }
} as const;

// Sweep animation button classes
const SWEEP_BUTTON = 'relative overflow-hidden border-0';
// The filled pills keep a frame in their resting color while hovered, so the button's edge stays
// visible once the wipe has covered it. Drawn as an `::after` at `z-1` rather than an outline: an
// element's own outline paints beneath its positioned children, so the wipe would cover it. A
// caller that gives a pill a border of its own adds `after:hidden`, or it shows a frame in a frame.
// Colored with `hover:`, not `group-hover/button:`: the frame belongs to the group element itself,
// and Tailwind's `group-hover` only matches the group's descendants, so it would never show.
const HOVER_FRAME =
	'after:pointer-events-none after:absolute after:inset-0 after:z-1 after:border-2 after:border-transparent';
export const SWEEP_CLASSES: Partial<
	Record<NonNullable<ButtonVariant>, { blocks: string; label: string; button: string }>
> = {
	default: {
		...COLORWAYS.dark,
		button: `${SWEEP_BUTTON} ${HOVER_FRAME} hover:bg-dark-blue hover:after:border-dark-blue`
	},
	secondary: {
		...COLORWAYS.salmon,
		button: `${SWEEP_BUTTON} ${HOVER_FRAME} hover:bg-secondary hover:after:border-secondary`
	},
	tertiary: {
		...COLORWAYS.light,
		button: `${SWEEP_BUTTON} ${HOVER_FRAME} hover:bg-tertiary hover:after:border-tertiary`
	},
	light: {
		...COLORWAYS.light,
		button: `${SWEEP_BUTTON} ${HOVER_FRAME} hover:bg-white hover:after:border-white`
	},
	// Keeps its border, unlike the others: on `outline-dark` that 2px rule is the style, not an
	// artifact. The wipe is its exact border color, so the filled state reads as one solid
	// block and no frame is left behind.
	'outline-dark': {
		blocks: 'bg-dark-blue',
		label: 'group-hover/button:text-white',
		button: 'relative overflow-hidden hover:bg-white'
	},
	'outline-salmon': {
		blocks: 'bg-salmon',
		label: 'group-hover/button:text-dark-blue',
		button: 'relative overflow-hidden hover:bg-transparent'
	}
};

/**
 * Wraps a wiping button's content: lifted over the wipe and recolored as it arrives. It grows to
 * fill the button and inherits its justify-content and gap, so a caller's `w-full justify-between`
 * still spreads its children.
 */
export const SWEEP_LABEL =
	'relative z-1 flex grow items-center gap-[inherit] [justify-content:inherit] transition-colors duration-300 motion-reduce:transition-none';

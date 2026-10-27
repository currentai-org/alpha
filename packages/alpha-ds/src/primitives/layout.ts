/**
 * Shared layout vocabularies for the primitives. Gaps are the 4px spacing scale by name — a
 * primitive never accepts an arbitrary length, which is what keeps rhythm consistent app-wide.
 * Class strings are written out in full so Tailwind's scanner sees them.
 */
export type Gap = '0' | '1' | '2' | '3' | '4' | '6' | '8' | '12';
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
export type Justify = 'start' | 'center' | 'end' | 'between';

export const gapClass: Record<Gap, string> = {
	'0': 'gap-0',
	'1': 'gap-1',
	'2': 'gap-2',
	'3': 'gap-3',
	'4': 'gap-4',
	'6': 'gap-6',
	'8': 'gap-8',
	'12': 'gap-12'
};

export const alignClass: Record<Align, string> = {
	start: 'items-start',
	center: 'items-center',
	end: 'items-end',
	stretch: 'items-stretch',
	baseline: 'items-baseline'
};

export const justifyClass: Record<Justify, string> = {
	start: 'justify-start',
	center: 'justify-center',
	end: 'justify-end',
	between: 'justify-between'
};

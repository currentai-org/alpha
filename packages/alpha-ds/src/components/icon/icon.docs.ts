import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'icon',
	name: 'Icon',
	layer: 'component',
	description: 'Wraps a Remix Icon component with the spec’s size and colour-by-role rules.',
	keywords: ['remix', 'svg', 'glyph'],
	baseUi: null,
	anatomy: '<Icon icon={RiAddLine} size="md" tone="default" />',
	parts: [
		{
			name: 'Icon',
			description: 'Renders the given `~icons/ri/*` component; decorative unless `label` is set.',
			props: [
				{
					name: 'icon',
					type: 'Component',
					description: 'A Remix Icon import, e.g. `~icons/ri/add-line`.'
				},
				{
					name: 'size',
					type: "'xs' | 'sm' | 'md' | 'lg' | 'xl'",
					default: "'md'",
					description: '12–24px.'
				},
				{
					name: 'tone',
					type: "'inherit' | 'default' | 'muted' | 'accent' | 'destructive'",
					default: "'inherit'",
					description: 'Accent tones are for -fill icons only.'
				},
				{
					name: 'label',
					type: 'string',
					description: 'Accessible name for a standalone meaningful icon.'
				}
			],
			dataAttributes: [
				{ name: 'data-icon', description: 'Always present — button recipes target it.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Line vs fill, by role' }],
	guidelines: {
		do: [
			'Line icons: Text 1, always.',
			'Fill icons: Text 1, Accent 1 (the one primary action), or Accent 2 (destructive).',
			'Pick the sharp-cornered Remix variant.'
		],
		dont: [
			'Tint a line icon with an accent.',
			'Add stroke/stroke-width — Remix glyphs are filled outlines.'
		]
	}
} satisfies DocEntry;

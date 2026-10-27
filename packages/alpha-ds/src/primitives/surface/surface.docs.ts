import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'surface',
	name: 'Surface',
	layer: 'primitive',
	description:
		'The only way to put a background tier down. Sets the fill and the surface context, so nested controls resolve “one tier up” and rule weight automatically.',
	keywords: ['background', 'card', 'panel', 'elevation', 'data-surface'],
	baseUi: null,
	anatomy: `<Surface level="2" border="auto" padding="md">…</Surface>`,
	parts: [
		{
			name: 'Surface',
			description: 'Sets data-surface + fill.',
			props: [
				{
					name: 'level',
					type: "'1' | '2' | '3' | 'chrome'",
					default: "'1'",
					description: 'Page · inset · floating · top bar.'
				},
				{
					name: 'border',
					type: "'none' | 'auto' | 'subtle' | 'strong'",
					default: "'none'",
					description: 'auto = contextual rule.'
				},
				{
					name: 'padding',
					type: "'none' | 'sm' | 'md' | 'lg'",
					default: "'none'",
					description: ''
				},
				{ name: 'as', type: 'string', default: "'div'", description: 'Element.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Tiers — the same Button adapts to each' }]
} satisfies DocEntry;

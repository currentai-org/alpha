import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'badge',
	name: 'Badge',
	layer: 'component',
	description: 'A label-sized tag: status, category, version.',
	keywords: ['tag', 'chip', 'label', 'status'],
	baseUi: null,
	anatomy: '<Badge tone="outline">Demo</Badge>',
	parts: [
		{
			name: 'Badge',
			description: 'DM Mono micro uppercase.',
			props: [
				{
					name: 'tone',
					type: "'outline' | 'solid' | 'accent' | 'positive' | 'caution' | 'destructive'",
					default: "'outline'",
					description: ''
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Tones' }],
	guidelines: {
		dont: ['Grow an accent badge to card size — switch to a Surface with an accent border instead.']
	}
} satisfies DocEntry;

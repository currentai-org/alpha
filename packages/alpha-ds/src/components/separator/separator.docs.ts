import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'separator',
	name: 'Separator',
	layer: 'component',
	description: 'A hairline rule. Follows the surface context — Border 3 on Background 3.',
	keywords: ['divider', 'rule', 'hr', 'line'],
	baseUi: { name: 'Separator', url: 'https://base-ui.com/react/components/separator' },
	anatomy: '<Separator />',
	parts: [
		{
			name: 'Separator',
			description: 'role=separator.',
			engine: 'bits-ui Separator.Root',
			props: [
				{
					name: 'orientation',
					type: "'horizontal' | 'vertical'",
					default: "'horizontal'",
					description: ''
				},
				{
					name: 'weight',
					type: "'subtle' | 'default' | 'strong'",
					default: "'default'",
					description: 'Border 1 / contextual / full ink.'
				}
			],
			dataAttributes: [{ name: 'data-orientation', description: '' }]
		}
	],
	examples: [{ file: 'Hero', title: 'Weights' }]
} satisfies DocEntry;

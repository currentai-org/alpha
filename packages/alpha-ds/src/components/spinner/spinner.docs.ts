import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'spinner',
	name: 'Spinner',
	layer: 'component',
	description: 'Indeterminate activity — four squares stepping, not a soft ring.',
	keywords: ['loading', 'busy', 'activity'],
	baseUi: null,
	anatomy: '<Spinner />',
	parts: [
		{
			name: 'Spinner',
			description: 'role=status.',
			props: [
				{ name: 'size', type: "'sm' | 'md' | 'lg'", default: "'md'", description: '' },
				{ name: 'label', type: 'string', default: "'Loading'", description: '' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Sizes' }]
} satisfies DocEntry;

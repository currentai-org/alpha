import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'inline',
	name: 'Inline',
	layer: 'primitive',
	description:
		'Horizontal flow with a token gap; wraps by default. Toolbars, chip rows, label + control.',
	keywords: ['row', 'hstack', 'horizontal', 'cluster', 'toolbar'],
	baseUi: null,
	anatomy: `<Inline gap="2">…</Inline>`,
	parts: [
		{
			name: 'Inline',
			description: 'flex-row.',
			props: [
				{ name: 'gap', type: 'Gap', default: "'2'", description: '' },
				{ name: 'align', type: 'Align', default: "'center'", description: '' },
				{ name: 'justify', type: 'Justify', default: "'start'", description: '' },
				{ name: 'wrap', type: 'boolean', default: 'true', description: '' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Toolbar' }]
} satisfies DocEntry;

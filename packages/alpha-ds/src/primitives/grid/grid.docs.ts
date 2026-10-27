import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'grid',
	name: 'Grid',
	layer: 'primitive',
	description:
		'Responsive columns: auto-fill by minimum width, or a fixed count. `ruled` draws brutalist hairlines instead of gaps.',
	keywords: ['columns', 'layout', 'cards', 'responsive'],
	baseUi: null,
	anatomy: `<Grid min="16rem" gap="4">…</Grid>`,
	parts: [
		{
			name: 'Grid',
			description: 'CSS grid.',
			props: [
				{ name: 'cols', type: '1 | 2 | 3 | 4 | 6', description: 'Fixed columns (responsive).' },
				{ name: 'min', type: 'string', default: "'16rem'", description: 'Auto-fill minimum.' },
				{ name: 'gap', type: 'Gap', default: "'4'", description: '' },
				{ name: 'ruled', type: 'boolean', default: 'false', description: 'Hairline grid.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Ruled grid' }]
} satisfies DocEntry;

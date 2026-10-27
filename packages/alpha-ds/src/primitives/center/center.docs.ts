import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'center',
	name: 'Center',
	layer: 'primitive',
	description:
		'A centred max-width column — the reading measure. `thread` is the conversation width.',
	keywords: ['container', 'max width', 'measure', 'column'],
	baseUi: null,
	anatomy: `<Center width="thread">…</Center>`,
	parts: [
		{
			name: 'Center',
			description: '',
			props: [
				{
					name: 'width',
					type: "'prose' | 'thread' | 'wide' | 'full'",
					default: "'thread'",
					description: ''
				},
				{ name: 'gutter', type: 'boolean', default: 'true', description: 'Side padding.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Thread width' }]
} satisfies DocEntry;

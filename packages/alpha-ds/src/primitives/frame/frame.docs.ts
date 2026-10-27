import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'frame',
	name: 'Frame',
	layer: 'primitive',
	description:
		'The brutalist window: a hard-ruled box with an optional chrome title bar. Carries the spec’s one permanent shadow.',
	keywords: ['window', 'panel', 'card', 'container', 'chrome'],
	baseUi: null,
	anatomy: `<Frame elevated>{#snippet title()}…{/snippet}…</Frame>`,
	parts: [
		{
			name: 'Frame',
			description: '',
			props: [
				{ name: 'title', type: 'Snippet', description: 'Title bar content.' },
				{ name: 'actions', type: 'Snippet', description: 'Title bar right side.' },
				{ name: 'elevated', type: 'boolean', default: 'false', description: 'The window shadow.' },
				{ name: 'weight', type: "'hairline' | 'strong'", default: "'strong'", description: '' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Window' }]
} satisfies DocEntry;

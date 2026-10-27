import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'thread-header',
	name: 'Thread Header',
	layer: 'pattern',
	description: 'The conversation top bar: title left, actions right, drawer toggle on mobile.',
	keywords: ['header', 'title bar', 'toolbar', 'conversation'],
	baseUi: null,
	anatomy: '<ThreadHeader title="…">{#snippet actions()}…{/snippet}</ThreadHeader>',
	parts: [
		{
			name: 'ThreadHeader',
			description: 'Sticky, Border 1 underneath.',
			props: [
				{ name: 'title', type: 'string | Snippet', description: 'Snippet for inline rename.' },
				{ name: 'leading', type: 'Snippet', description: 'Before the title (model badge).' },
				{ name: 'actions', type: 'Snippet', description: 'Right side.' },
				{
					name: 'openSidebarLabel',
					type: 'string',
					default: "'Open sidebar'",
					description: 'Localized accessible label for the mobile drawer button.'
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'With actions' }]
} satisfies DocEntry;

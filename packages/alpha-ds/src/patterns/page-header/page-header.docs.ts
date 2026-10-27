import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'page-header',
	name: 'Page Header',
	layer: 'pattern',
	description: 'Title block for non-conversation pages — settings, models, docs.',
	keywords: ['title', 'heading', 'settings', 'page'],
	baseUi: null,
	anatomy:
		'<PageHeader eyebrow="…" title="…" description="…">{#snippet actions()}…{/snippet}</PageHeader>',
	parts: [
		{
			name: 'PageHeader',
			description: 'Hard rule underneath.',
			props: [
				{ name: 'eyebrow', type: 'string', description: 'DM Mono label.' },
				{
					name: 'breadcrumbs',
					type: '{ label: string; href?: string }[]',
					description:
						'Parent pages, outermost first, each a link back; the title is the current page. Replaces the eyebrow on nested pages.'
				},
				{ name: 'title', type: 'string', description: '' },
				{ name: 'description', type: 'string', description: '' },
				{ name: 'actions', type: 'Snippet', description: '' }
			]
		}
	],
	examples: [
		{ file: 'Hero', title: 'Settings page' },
		{
			file: 'Breadcrumbs',
			title: 'Nested page',
			description: 'A page one level down links back up its trail.'
		}
	]
} satisfies DocEntry;

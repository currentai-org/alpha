import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'empty-state',
	name: 'Empty State',
	layer: 'pattern',
	description:
		'The new-conversation landing: mark, heading, the composer, then prompt suggestions.',
	keywords: ['landing', 'welcome', 'greeting', 'suggestions', 'prompt examples'],
	baseUi: null,
	anatomy: `<EmptyState title="…" description="…">
  <Composer.Root />
  {#snippet suggestions()}
    <EmptyStateSuggestion />
  {/snippet}
</EmptyState>`,
	parts: [
		{
			name: 'EmptyState',
			description: 'Heading is Font 2 Size 5 (spec empty-state type).',
			props: [
				{ name: 'title', type: 'string', description: '' },
				{ name: 'description', type: 'string', description: 'Text 3, still AA.' },
				{ name: 'mark', type: 'Snippet', description: 'Defaults to the Potluck diamond.' },
				{ name: 'suggestions', type: 'Snippet', description: '' }
			]
		},
		{
			name: 'EmptyStateSuggestion',
			description: 'Prompt-example button — Radius 2, Text 3 → Text 1.',
			props: [
				{
					name: 'disabled',
					type: 'boolean',
					description: 'Shown but not clickable, e.g. until the page can act on a click.'
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Landing' }]
} satisfies DocEntry;

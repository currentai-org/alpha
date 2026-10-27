import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'danger-row',
	name: 'Danger Row',
	layer: 'pattern',
	description:
		'One irreversible action in a settings card: what it does, then a small destructive button. Every danger zone uses it, so they match in size and frame.',
	keywords: ['danger zone', 'delete', 'destructive', 'forget', 'settings'],
	baseUi: null,
	anatomy: `<Surface level="2" border="auto">
  <DangerRow title="…" onclick={…}>
    {#snippet description()}…{/snippet}
    <Icon /> Label
  </DangerRow>
</Surface>`,
	parts: [
		{
			name: 'DangerRow',
			description: 'Row padding and a size-sm destructive Button; the card around it is a Surface.',
			props: [
				{
					name: 'title',
					type: 'string',
					description: 'Leave out when a heading above already names it.'
				},
				{
					name: 'description',
					type: 'Snippet',
					description: 'Caption under the title, or body text alone.'
				},
				{
					name: 'ref',
					type: 'HTMLElement | null',
					description: 'Bindable; the button, to anchor a confirm.'
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Delete account' }]
} satisfies DocEntry;

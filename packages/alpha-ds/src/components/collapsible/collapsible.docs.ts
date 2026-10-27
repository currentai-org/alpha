import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'collapsible',
	name: 'Collapsible',
	layer: 'component',
	description: 'One trigger, one panel. For a single show/hide region.',
	keywords: ['disclosure', 'expand', 'details', 'show more'],
	baseUi: { name: 'Collapsible', url: 'https://base-ui.com/react/components/collapsible' },
	anatomy: `<Collapsible.Root>
  <Collapsible.Trigger />
  <Collapsible.Panel />
</Collapsible.Root>`,
	parts: [
		{
			name: 'Collapsible.Root',
			description: 'Owns open state.',
			engine: 'bits-ui Collapsible.Root',
			props: [
				{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' }
			],
			dataAttributes: [{ name: 'data-open (data-state=open)', description: '' }]
		},
		{
			name: 'Collapsible.Trigger',
			description: 'Styled as a ghost Button; accepts Button variants.',
			engine: 'bits-ui Collapsible.Trigger'
		},
		{
			name: 'Collapsible.Panel',
			description: 'The region.',
			engine: 'bits-ui Collapsible.Content',
			props: [{ name: 'keepMounted', type: 'boolean', default: 'false', description: '' }],
			cssVariables: [{ name: '--collapsible-panel-height', description: 'Measured height.' }]
		}
	],
	examples: [{ file: 'Hero', title: 'Show reasoning' }]
} satisfies DocEntry;

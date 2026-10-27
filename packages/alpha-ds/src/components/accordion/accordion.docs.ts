import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'accordion',
	name: 'Accordion',
	layer: 'component',
	description:
		'A stack of headings that each reveal a panel. Ruled, left-aligned, plus/minus swap.',
	keywords: ['disclosure', 'expand', 'collapse', 'faq'],
	baseUi: { name: 'Accordion', url: 'https://base-ui.com/react/components/accordion' },
	anatomy: `<Accordion.Root>
  <Accordion.Item>
    <Accordion.Header>
      <Accordion.Trigger />
    </Accordion.Header>
    <Accordion.Panel />
  </Accordion.Item>
</Accordion.Root>`,
	parts: [
		{
			name: 'Accordion.Root',
			description: 'Groups items and owns which are open.',
			engine: 'bits-ui Accordion.Root',
			props: [
				{
					name: 'value',
					type: 'string[]',
					default: '[]',
					description: 'Open item values. Bindable. Always an array (Base UI).'
				},
				{
					name: 'multiple',
					type: 'boolean',
					default: 'false',
					description: 'Allow several open at once.'
				},
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' },
				{
					name: 'orientation',
					type: "'vertical' | 'horizontal'",
					default: "'vertical'",
					description: 'Arrow-key axis.'
				},
				{ name: 'loop', type: 'boolean', default: 'true', description: 'Wrap keyboard focus.' },
				{ name: 'onValueChange', type: '(value: string[]) => void', description: '' }
			],
			dataAttributes: [
				{ name: 'data-orientation', description: 'Axis.' },
				{ name: 'data-disabled', description: '' }
			]
		},
		{
			name: 'Accordion.Item',
			description: 'One section.',
			engine: 'bits-ui Accordion.Item',
			props: [
				{ name: 'value', type: 'string', description: 'Identity.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' }
			],
			dataAttributes: [
				{ name: 'data-open (data-state=open)', description: 'Expanded.' },
				{ name: 'data-disabled', description: '' }
			]
		},
		{
			name: 'Accordion.Header',
			description: 'Heading wrapper for the trigger.',
			engine: 'bits-ui Accordion.Header',
			props: [{ name: 'level', type: '1–6', default: '3', description: 'Heading level.' }]
		},
		{
			name: 'Accordion.Trigger',
			description: 'Toggles the panel.',
			engine: 'bits-ui Accordion.Trigger',
			dataAttributes: [
				{ name: 'data-panel-open (data-state=open)', description: 'Panel expanded.' }
			]
		},
		{
			name: 'Accordion.Panel',
			description: 'Collapsible content.',
			engine: 'bits-ui Accordion.Content',
			props: [
				{
					name: 'keepMounted',
					type: 'boolean',
					default: 'false',
					description: 'Keep in DOM when closed.'
				},
				{
					name: 'hiddenUntilFound',
					type: 'boolean',
					default: 'false',
					description: 'Find-in-page reveals closed panels.'
				}
			],
			dataAttributes: [
				{ name: 'data-open / data-closed (data-state)', description: 'Panel state.' }
			],
			cssVariables: [
				{ name: '--accordion-panel-height', description: 'Measured height, for animations.' }
			]
		}
	],
	examples: [
		{ file: 'Hero', title: 'Single' },
		{
			file: 'Multiple',
			title: 'Multiple panels',
			description: 'Set `multiple` to allow several open.'
		},
		{
			file: 'HiddenUntilFound',
			title: 'Hidden until found',
			description: 'Closed panels stay searchable with find-in-page.'
		}
	]
} satisfies DocEntry;

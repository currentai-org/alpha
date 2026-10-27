import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'popover',
	name: 'Popover',
	layer: 'component',
	description: 'An anchored, interactive panel. Background 3, Border 3, hard offset shadow.',
	keywords: ['floating', 'panel', 'dropdown', 'anchored'],
	baseUi: { name: 'Popover', url: 'https://base-ui.com/react/components/popover' },
	anatomy: `<Popover.Root>
  <Popover.Trigger />
  <Popover.Portal>
    <Popover.Positioner>
      <Popover.Popup>
        <Popover.Arrow />
        <Popover.Title />
        <Popover.Description />
        <Popover.Close />
      </Popover.Popup>
    </Popover.Positioner>
  </Popover.Portal>
</Popover.Root>`,
	parts: [
		{
			name: 'Popover.Root',
			description: '',
			engine: 'bits-ui Popover.Root',
			props: [{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' }]
		},
		{
			name: 'Popover.Trigger',
			description: 'Styled as a Button.',
			engine: 'bits-ui Popover.Trigger'
		},
		{ name: 'Popover.Portal', description: 'Themed body-level portal.' },
		{
			name: 'Popover.Positioner',
			description: 'Placement (Base UI splits this from Popup; we keep the split).',
			props: [
				{
					name: 'side',
					type: "'top' | 'right' | 'bottom' | 'left'",
					default: "'bottom'",
					description: ''
				},
				{ name: 'align', type: "'start' | 'center' | 'end'", default: "'center'", description: '' },
				{ name: 'sideOffset / alignOffset', type: 'number', default: '6 / 0', description: 'px' },
				{ name: 'collisionPadding', type: 'number', default: '8', description: '' }
			]
		},
		{
			name: 'Popover.Popup',
			description: 'The panel; surface 3.',
			engine: 'bits-ui Popover.Content',
			props: [
				{ name: 'size', type: "'auto' | 'sm' | 'md' | 'lg'", default: "'auto'", description: '' },
				{ name: 'padded', type: 'boolean', default: 'true', description: '' }
			],
			dataAttributes: [
				{ name: 'data-side / data-align', description: 'Resolved placement.' },
				{ name: 'data-open (data-state=open)', description: '' }
			]
		},
		{ name: 'Popover.Arrow', description: '', engine: 'bits-ui Popover.Arrow' },
		{ name: 'Popover.Title / Description', description: 'Text parts.' },
		{ name: 'Popover.Close', description: 'Styled as a Button.' }
	],
	examples: [{ file: 'Hero', title: 'Share settings' }]
} satisfies DocEntry;

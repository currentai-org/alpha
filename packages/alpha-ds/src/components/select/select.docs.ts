import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'select',
	name: 'Select',
	layer: 'component',
	description: 'Choose one value from a list, with an Input-skinned trigger.',
	keywords: ['dropdown', 'picker', 'combobox', 'options', 'model picker'],
	baseUi: { name: 'Select', url: 'https://base-ui.com/react/components/select' },
	deviations: ['`ItemText`/`ItemIndicator` are folded into `Item`.', 'Single-select only.'],
	anatomy: `<Select.Root items={items}>
  <Select.Trigger>
    <Select.Value />
    <Select.Icon />
  </Select.Trigger>
  <Select.Portal>
    <Select.Positioner>
      <Select.Popup>
        <Select.Item />
      </Select.Popup>
    </Select.Positioner>
  </Select.Portal>
</Select.Root>`,
	parts: [
		{
			name: 'Select.Root',
			description: '',
			engine: 'bits-ui Select.Root',
			props: [
				{ name: 'value', type: 'string', description: 'Bindable.' },
				{
					name: 'items',
					type: '{ value, label, disabled? }[]',
					description: 'Lets Value show a label before first open.'
				},
				{ name: 'name / required / disabled', type: '', description: 'Form participation.' }
			]
		},
		{
			name: 'Select.Trigger',
			description: 'Input skin; joins a Field.',
			engine: 'bits-ui Select.Trigger',
			dataAttributes: [{ name: 'data-open (data-state=open)', description: '' }]
		},
		{
			name: 'Select.Value',
			description: 'Selected label or placeholder.',
			engine: 'bits-ui Select.Value',
			props: [{ name: 'placeholder', type: 'string', default: "'Select…'", description: '' }]
		},
		{ name: 'Select.Icon', description: 'Chevron.' },
		{
			name: 'Select.Positioner',
			description: 'Placement.',
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
			name: 'Select.Popup',
			description:
				'List; at least trigger width. A list longer than the space fades at the edge with more.',
			engine: 'bits-ui Select.Content'
		},
		{
			name: 'Select.Item',
			description: 'Option; draws its check.',
			engine: 'bits-ui Select.Item',
			props: [
				{ name: 'value', type: 'string', description: '' },
				{ name: 'label', type: 'string', description: 'Typeahead text.' }
			],
			dataAttributes: [
				{ name: 'data-highlighted', description: '' },
				{ name: 'data-selected', description: '' }
			]
		},
		{ name: 'Select.Group / GroupLabel / Separator', description: 'Structure.' }
	],
	examples: [{ file: 'Hero', title: 'Model picker' }]
} satisfies DocEntry;

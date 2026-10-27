import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'checkbox',
	name: 'Checkbox',
	layer: 'component',
	description: 'A square, sharp checkbox with checked and indeterminate states.',
	keywords: ['check', 'form', 'toggle', 'boolean'],
	baseUi: { name: 'Checkbox', url: 'https://base-ui.com/react/components/checkbox' },
	anatomy: `<Checkbox.Root>
  <Checkbox.Indicator />
</Checkbox.Root>`,
	parts: [
		{
			name: 'Checkbox.Root',
			description: 'The control.',
			engine: 'bits-ui Checkbox.Root',
			props: [
				{ name: 'checked', type: 'boolean', default: 'false', description: 'Bindable.' },
				{ name: 'indeterminate', type: 'boolean', default: 'false', description: 'Bindable.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' },
				{
					name: 'name / value / required',
					type: 'string / string / boolean',
					description: 'Form participation.'
				}
			],
			dataAttributes: [
				{ name: 'data-checked (data-state=checked)', description: 'Checked.' },
				{ name: 'data-indeterminate', description: 'Mixed.' },
				{ name: 'data-disabled', description: 'Disabled.' }
			]
		},
		{
			name: 'Checkbox.Indicator',
			description: 'Visible while checked/indeterminate; Remix check/subtract by default.',
			props: [
				{
					name: 'keepMounted',
					type: 'boolean',
					default: 'false',
					description: 'Keep in DOM when unchecked.'
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'With labels' }]
} satisfies DocEntry;

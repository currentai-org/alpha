import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'radio',
	name: 'Radio',
	layer: 'component',
	description: 'One choice from a small set. Square radios, keyboard-roving.',
	keywords: ['radio group', 'choice', 'option', 'form'],
	baseUi: { name: 'Radio', url: 'https://base-ui.com/react/components/radio' },
	anatomy: `<RadioGroup>
  <Radio.Root value="a">
    <Radio.Indicator />
  </Radio.Root>
</RadioGroup>`,
	parts: [
		{
			name: 'RadioGroup',
			description: 'Holds the value.',
			engine: 'bits-ui RadioGroup.Root',
			props: [
				{ name: 'value', type: 'string', description: 'Bindable.' },
				{
					name: 'orientation',
					type: "'vertical' | 'horizontal'",
					default: "'vertical'",
					description: ''
				}
			]
		},
		{
			name: 'Radio.Root',
			description: 'One option.',
			engine: 'bits-ui RadioGroup.Item',
			props: [{ name: 'value', type: 'string', description: 'Required.' }],
			dataAttributes: [{ name: 'data-checked (data-state=checked)', description: 'Selected.' }]
		},
		{ name: 'Radio.Indicator', description: 'The inner mark.' }
	],
	examples: [{ file: 'Hero', title: 'Theme choice' }]
} satisfies DocEntry;

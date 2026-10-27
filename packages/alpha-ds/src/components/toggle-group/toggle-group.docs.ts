import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'toggle-group',
	name: 'Toggle Group',
	layer: 'component',
	description: 'A set of Toggles sharing one value — a segmented control by default.',
	keywords: ['segmented', 'segment', 'group', 'tabs'],
	baseUi: { name: 'Toggle Group', url: 'https://base-ui.com/react/components/toggle-group' },
	anatomy: `<ToggleGroup>
  <Toggle value="a" />
</ToggleGroup>`,
	parts: [
		{
			name: 'ToggleGroup',
			description: 'Value is always an array, as in Base UI.',
			engine: 'bits-ui ToggleGroup.Root',
			props: [
				{ name: 'value', type: 'string[]', default: '[]', description: 'Bindable.' },
				{
					name: 'onValueChange',
					type: '(value: string[]) => void',
					description: 'Called with the new pressed values.'
				},
				{
					name: 'multiple',
					type: 'boolean',
					default: 'false',
					description: 'Allow several pressed.'
				},
				{
					name: 'variant',
					type: "'segment' | 'pill' | 'tile'",
					default: "'segment'",
					description: 'Applied to child Toggles.'
				},
				{
					name: 'orientation',
					type: "'horizontal' | 'vertical'",
					default: "'horizontal'",
					description: ''
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Segmented mode switch' }]
} satisfies DocEntry;

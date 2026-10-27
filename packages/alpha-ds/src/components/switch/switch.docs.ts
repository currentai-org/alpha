import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'switch',
	name: 'Switch',
	layer: 'component',
	description:
		'An on/off control for settings that apply immediately. Square thumb, ink track when on.',
	keywords: ['toggle', 'setting', 'boolean'],
	baseUi: { name: 'Switch', url: 'https://base-ui.com/react/components/switch' },
	anatomy: `<Switch.Root>
  <Switch.Thumb />
</Switch.Root>`,
	parts: [
		{
			name: 'Switch.Root',
			description: 'The control.',
			engine: 'bits-ui Switch.Root',
			props: [
				{ name: 'checked', type: 'boolean', default: 'false', description: 'Bindable.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' }
			],
			dataAttributes: [
				{ name: 'data-checked (data-state=checked)', description: 'On.' },
				{ name: 'data-disabled', description: 'Disabled.' }
			]
		},
		{ name: 'Switch.Thumb', description: 'The moving square.', engine: 'bits-ui Switch.Thumb' }
	],
	examples: [{ file: 'Hero', title: 'Settings rows' }]
} satisfies DocEntry;

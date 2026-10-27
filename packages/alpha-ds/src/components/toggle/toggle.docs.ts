import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'toggle',
	name: 'Toggle',
	layer: 'component',
	description:
		'A two-state button — the in-chat toggle pill (“Web search”), an icon tile, or a segment.',
	keywords: ['pressed', 'pill', 'tool', 'switch button'],
	baseUi: { name: 'Toggle', url: 'https://base-ui.com/react/components/toggle' },
	anatomy: '<Toggle bind:pressed>Web search</Toggle>',
	parts: [
		{
			name: 'Toggle',
			description: 'Becomes a ToggleGroup item when inside one.',
			engine: 'bits-ui Toggle.Root',
			props: [
				{ name: 'pressed', type: 'boolean', default: 'false', description: 'Bindable.' },
				{
					name: 'variant',
					type: "'pill' | 'tile' | 'segment'",
					default: "'pill'",
					description: 'Pill = Radius 3 in-chat toggle.'
				},
				{ name: 'value', type: 'string', description: 'Identity inside a ToggleGroup.' }
			],
			dataAttributes: [{ name: 'data-pressed (data-state=on)', description: 'Pressed.' }]
		}
	],
	examples: [{ file: 'Hero', title: 'Pill and tile' }]
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'tabs',
	name: 'Tabs',
	layer: 'component',
	description:
		'Switch between views of the same context. Ruled list with an ink bar on the selected tab, or a segmented control for a few peer views.',
	keywords: ['tab', 'segments', 'views'],
	baseUi: { name: 'Tabs', url: 'https://base-ui.com/react/components/tabs' },
	deviations: [
		'`Tabs.Indicator` is folded into `Tabs.Tab` (the selected tab draws its own bar) — no animated indicator element.'
	],
	anatomy: `<Tabs.Root>
  <Tabs.List>
    <Tabs.Tab />
  </Tabs.List>
  <Tabs.Panel />
</Tabs.Root>`,
	parts: [
		{
			name: 'Tabs.Root',
			description: 'Owns the selected value.',
			engine: 'bits-ui Tabs.Root',
			props: [
				{ name: 'value', type: 'string', description: 'Bindable.' },
				{
					name: 'variant',
					type: "'line' | 'segment'",
					default: "'line'",
					description:
						'`line`: ruled strip, ink bar under the selected tab. `segment`: a segmented control, for a few peer views of one place (storage locations). Applied to the List and its Tabs.'
				},
				{
					name: 'orientation',
					type: "'horizontal' | 'vertical'",
					default: "'horizontal'",
					description: ''
				}
			]
		},
		{ name: 'Tabs.List', description: 'The ruled tab strip.', engine: 'bits-ui Tabs.List' },
		{
			name: 'Tabs.Tab',
			description: 'One tab.',
			engine: 'bits-ui Tabs.Trigger',
			props: [{ name: 'value', type: 'string', description: 'Required.' }],
			dataAttributes: [{ name: 'data-selected (data-state=active)', description: 'Selected.' }]
		},
		{
			name: 'Tabs.Panel',
			description: 'Content for one value.',
			engine: 'bits-ui Tabs.Content',
			props: [{ name: 'value', type: 'string', description: 'Required.' }]
		}
	],
	examples: [
		{ file: 'Hero', title: 'Basic' },
		{ file: 'Segment', title: 'Segmented (peer places)' }
	]
} satisfies DocEntry;

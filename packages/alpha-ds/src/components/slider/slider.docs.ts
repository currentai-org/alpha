import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'slider',
	name: 'Slider',
	layer: 'component',
	description: 'Pick a number in a range. Hard track, square thumb.',
	keywords: ['range', 'number', 'input'],
	baseUi: { name: 'Slider', url: 'https://base-ui.com/react/components/slider' },
	deviations: ['Single-value only (Base UI supports ranges with multiple thumbs).'],
	anatomy: `<Slider.Root>
  <Slider.Control>
    <Slider.Track>
      <Slider.Indicator />
      <Slider.Thumb />
    </Slider.Track>
  </Slider.Control>
</Slider.Root>`,
	parts: [
		{
			name: 'Slider.Root',
			description: 'Holds the value.',
			engine: 'bits-ui Slider.Root',
			props: [
				{ name: 'value', type: 'number', default: '0', description: 'Bindable.' },
				{ name: 'min / max / step', type: 'number', default: '0 / 100 / 1', description: '' },
				{
					name: 'onValueCommitted',
					type: '(value: number) => void',
					description: 'Fires on release.'
				}
			]
		},
		{ name: 'Slider.Control', description: 'Hit area.' },
		{ name: 'Slider.Track', description: 'The rail.' },
		{ name: 'Slider.Indicator', description: 'Filled portion.', engine: 'bits-ui Slider.Range' },
		{ name: 'Slider.Thumb', description: 'The handle.', engine: 'bits-ui Slider.Thumb' }
	],
	examples: [{ file: 'Hero', title: 'Basic' }]
} satisfies DocEntry;

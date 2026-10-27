import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'progress',
	name: 'Progress',
	layer: 'component',
	description: 'Completion of a task. `value={null}` is indeterminate.',
	keywords: ['loading', 'bar', 'upload', 'percent'],
	baseUi: { name: 'Progress', url: 'https://base-ui.com/react/components/progress' },
	anatomy: `<Progress.Root>
  <Progress.Label />
  <Progress.Value />
  <Progress.Track>
    <Progress.Indicator />
  </Progress.Track>
</Progress.Root>`,
	parts: [
		{
			name: 'Progress.Root',
			description: 'role=progressbar.',
			props: [
				{
					name: 'value',
					type: 'number | null',
					default: 'null',
					description: 'null = indeterminate.'
				},
				{ name: 'min / max', type: 'number', default: '0 / 100', description: '' },
				{
					name: 'format',
					type: 'Intl.NumberFormatOptions | (v) => string',
					description: 'Value formatting.'
				}
			],
			dataAttributes: [
				{ name: 'data-indeterminate', description: '' },
				{ name: 'data-complete', description: 'value ≥ max.' }
			]
		},
		{ name: 'Progress.Label', description: 'Accessible name.' },
		{ name: 'Progress.Value', description: 'Formatted value.' },
		{ name: 'Progress.Track', description: 'Rail.' },
		{
			name: 'Progress.Indicator',
			description: 'Fill.',
			props: [{ name: 'tone', type: "'default' | 'accent'", default: "'default'", description: '' }]
		}
	],
	examples: [{ file: 'Hero', title: 'Determinate and indeterminate' }]
} satisfies DocEntry;

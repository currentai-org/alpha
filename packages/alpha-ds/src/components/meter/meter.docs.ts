import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'meter',
	name: 'Meter',
	layer: 'component',
	description:
		'A measurement within a known range — energy used, context window. Not task progress.',
	keywords: ['gauge', 'usage', 'quota', 'energy'],
	baseUi: { name: 'Meter', url: 'https://base-ui.com/react/components/meter' },
	anatomy: `<Meter.Root>
  <Meter.Label />
  <Meter.Value />
  <Meter.Track>
    <Meter.Indicator />
  </Meter.Track>
</Meter.Root>`,
	parts: [
		{
			name: 'Meter.Root',
			description: 'role=meter. Same props as Progress.Root (value is required in practice).'
		},
		{ name: 'Meter.Label / Value / Track / Indicator', description: 'Shared with Progress.' }
	],
	examples: [{ file: 'Hero', title: 'Session energy' }]
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'tooltip',
	name: 'Tooltip',
	layer: 'component',
	description:
		'A transient label on hover/focus — inverse surface, DM Mono micro. Names icon-only controls.',
	keywords: ['hint', 'label', 'hover'],
	baseUi: { name: 'Tooltip', url: 'https://base-ui.com/react/components/tooltip' },
	deviations: ['A Provider is mounted by every ThemeProvider, so `Tooltip.Provider` is optional.'],
	anatomy: `<Tooltip.Root>
  <Tooltip.Trigger />
  <Tooltip.Portal>
    <Tooltip.Positioner>
      <Tooltip.Popup>
        <Tooltip.Arrow />
      </Tooltip.Popup>
    </Tooltip.Positioner>
  </Tooltip.Portal>
</Tooltip.Root>`,
	parts: [
		{
			name: 'Tooltip.Provider',
			description: 'Shared delays.',
			engine: 'bits-ui Tooltip.Provider',
			props: [{ name: 'delayDuration', type: 'number', default: '500', description: 'ms' }]
		},
		{
			name: 'Tooltip.Root',
			description: '',
			engine: 'bits-ui Tooltip.Root',
			props: [
				{ name: 'open', type: 'boolean', description: 'Bindable.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' }
			]
		},
		{
			name: 'Tooltip.Trigger',
			description: 'Unstyled unless `variant` is set; usually wraps a control via `child`.',
			engine: 'bits-ui Tooltip.Trigger'
		},
		{
			name: 'Tooltip.Positioner',
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
		{ name: 'Tooltip.Popup', description: 'The label.', engine: 'bits-ui Tooltip.Content' },
		{ name: 'Tooltip.Arrow', description: '' }
	],
	examples: [{ file: 'Hero', title: 'On icon buttons' }]
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'preview-card',
	name: 'Preview Card',
	layer: 'component',
	description:
		'Hover or focus to reveal supplementary detail — the spec’s footprint progressive-disclosure pattern.',
	keywords: ['hover card', 'link preview', 'disclosure', 'footprint'],
	baseUi: { name: 'Preview Card', url: 'https://base-ui.com/react/components/preview-card' },
	deviations: [
		'`inverse` on Popup flips mode for its subtree — the spec’s one deliberate light-on-dark card.'
	],
	anatomy: `<PreviewCard.Root>
  <PreviewCard.Trigger />
  <PreviewCard.Portal>
    <PreviewCard.Positioner>
      <PreviewCard.Popup>
        <PreviewCard.Arrow />
      </PreviewCard.Popup>
    </PreviewCard.Positioner>
  </PreviewCard.Portal>
</PreviewCard.Root>`,
	parts: [
		{
			name: 'PreviewCard.Root',
			description: '',
			engine: 'bits-ui LinkPreview.Root',
			props: [
				{ name: 'delay', type: 'number', default: '300', description: 'Open delay ms.' },
				{ name: 'closeDelay', type: 'number', default: '150', description: '' }
			]
		},
		{
			name: 'PreviewCard.Trigger',
			description: 'Wraps the compact element.',
			engine: 'bits-ui LinkPreview.Trigger'
		},
		{
			name: 'PreviewCard.Positioner',
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
		{
			name: 'PreviewCard.Popup',
			description: '',
			engine: 'bits-ui LinkPreview.Content',
			props: [
				{
					name: 'inverse',
					type: 'boolean',
					default: 'false',
					description: 'Flip to the opposite mode.'
				}
			]
		},
		{ name: 'PreviewCard.Arrow', description: '' }
	],
	examples: [{ file: 'Hero', title: 'Footprint pill' }]
} satisfies DocEntry;

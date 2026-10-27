import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'scroll-area',
	name: 'Scroll Area',
	layer: 'component',
	description: 'A scroll container with thin, square, themed scrollbars.',
	keywords: ['scroll', 'overflow', 'scrollbar'],
	baseUi: { name: 'Scroll Area', url: 'https://base-ui.com/react/components/scroll-area' },
	anatomy: `<ScrollArea.Root>
  <ScrollArea.Viewport>
    <ScrollArea.Content />
  </ScrollArea.Viewport>
  <ScrollArea.Scrollbar>
    <ScrollArea.Thumb />
  </ScrollArea.Scrollbar>
  <ScrollArea.Corner />
</ScrollArea.Root>`,
	parts: [
		{
			name: 'ScrollArea.Root',
			description: 'Frame.',
			engine: 'bits-ui ScrollArea.Root',
			props: [
				{
					name: 'type',
					type: "'hover' | 'scroll' | 'auto' | 'always'",
					default: "'hover'",
					description: 'When scrollbars show.'
				}
			]
		},
		{
			name: 'ScrollArea.Viewport',
			description: 'The scrolling element.',
			engine: 'bits-ui ScrollArea.Viewport'
		},
		{ name: 'ScrollArea.Content', description: 'Content box.' },
		{
			name: 'ScrollArea.Scrollbar',
			description: 'Renders its Thumb when empty.',
			engine: 'bits-ui ScrollArea.Scrollbar',
			props: [
				{
					name: 'orientation',
					type: "'vertical' | 'horizontal'",
					default: "'vertical'",
					description: ''
				}
			]
		},
		{ name: 'ScrollArea.Thumb', description: '', engine: 'bits-ui ScrollArea.Thumb' },
		{ name: 'ScrollArea.Corner', description: '', engine: 'bits-ui ScrollArea.Corner' }
	],
	examples: [{ file: 'Hero', title: 'Vertical list' }]
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'ticker',
	name: 'Ticker',
	layer: 'pattern',
	description:
		'One line of text that may not fit: the clipped edge fades instead of an ellipsis, and hovering its row scrolls the rest into view on a loop.',
	keywords: ['marquee', 'truncate', 'overflow', 'ellipsis', 'scroll', 'subtext', 'fade', 'mask'],
	baseUi: null,
	anatomy: `<button>
  <span class="type-caption text-fg-3">
    <Ticker>Barcelona Supercomputing Center · runs on NextBit</Ticker>
  </span>
</button>`,
	parts: [
		{
			name: 'Ticker',
			description:
				'A block-level line built on the scroll-fade-x utility. Text that fits renders plain; text that overflows fades at the edge it is clipped on. While playing it pauses at the start, scrolls to the end, pauses, fades back to the start and loops. With reduced motion it keeps the fade and never scrolls.',
			engine: 'native <span>, Web Animations API',
			props: [
				{
					name: 'play',
					type: 'boolean',
					description:
						'Scroll now. Unset, it scrolls while its host — the nearest button, link, label, menu item, option, radio, tab or `[data-ticker-host]` around it — is hovered or keyboard-focused.'
				},
				{
					name: 'speed',
					type: 'number',
					default: '40',
					description: 'Scroll speed in px per second.'
				},
				{
					name: 'pause',
					type: 'number',
					default: '1200',
					description: 'Pause at each end, in ms.'
				},
				{
					name: 'fade',
					type: 'number',
					default: '16',
					description: 'Length of the edge fade, in px.'
				},
				{
					name: 'class',
					type: 'string',
					description:
						'Layout only. The ticker sets no text style: it inherits type and colour from its parent.'
				}
			],
			dataAttributes: [
				{ name: 'data-overflowing', description: 'The text is wider than the line.' },
				{ name: 'data-playing', description: 'Scrolling now.' }
			]
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'In a picker row',
			description: 'Hover a row, or tab to it, to read the whole line.'
		},
		{
			file: 'Controlled',
			title: 'Playing on demand',
			description: '`play` drives it directly, without a host.'
		}
	],
	guidelines: {
		do: [
			'Use it for secondary lines whose end matters but rarely fits: provenance, paths, credits.',
			'Put it inside the interactive row it describes, so hovering the row reads the line.',
			'Give the line and its parent `min-w-0` in a flex row, or it never overflows.',
			'Set type and colour on a wrapper; the ticker inherits them.'
		],
		dont: [
			'Use it for a primary label or a heading: those should wrap or be shortened.',
			'Put two playing tickers next to each other; one moving line at a time.',
			'Use it where the text must be copied or selected while moving.'
		]
	}
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'composer-accessory',
	name: 'Composer accessory',
	layer: 'pattern',
	description:
		'Pills attached to the composer that open context panels at the composer’s full width — model choice, privacy, provenance. One panel at a time. A Notice says something about the message being written on the composer’s top edge.',
	keywords: [
		'pill',
		'chip',
		'provenance',
		'privacy',
		'model picker',
		'composer',
		'disclosure',
		'notice',
		'attachment'
	],
	baseUi: null,
	anatomy: `<ComposerAccessory.Root bind:open>
  <ComposerAccessory.Panel value="privacy" label="…" />
  <Composer.Root>…</Composer.Root>
  <ComposerAccessory.Row>
    <ComposerAccessory.Pill value="privacy" icon={…}>…</ComposerAccessory.Pill>
  </ComposerAccessory.Row>
</ComposerAccessory.Root>`,
	parts: [
		{
			name: 'ComposerAccessory.Root',
			description:
				'Wraps the composer; panels render in flow at its width. The open panel stays open until its close button, its pill, or Escape from inside the composer.',
			props: [
				{
					name: 'open',
					type: 'string | null',
					default: 'null',
					description: 'Open panel value. Bindable.'
				}
			]
		},
		{
			name: 'ComposerAccessory.Row',
			description: 'The pill strip.',
			props: [
				{ name: 'label', type: 'string', default: "'Message options'", description: 'Group name.' }
			]
		},
		{
			name: 'ComposerAccessory.Pill',
			description: 'Radius 3 disclosure button; aria-expanded + aria-controls.',
			props: [
				{ name: 'value', type: 'string', description: 'Which panel it opens.' },
				{ name: 'icon', type: 'Component', description: 'Remix icon.' },
				{ name: 'label', type: 'string', description: 'Accessible name when the text is terse.' },
				{
					name: 'tone',
					type: "'default' | 'xray' | 'seed'",
					default: "'default'",
					description:
						'xray: cool hairline and mark, faint sweep (XRAY entry point). seed: warm accent mark (a language Alpha is still learning).'
				}
			]
		},
		{
			name: 'ComposerAccessory.Notice',
			description:
				'One line on the composer’s top edge at its width, about the message being written (a refused file, a photo the model won’t read). role=status; stays until dismissed or its cause goes away. Eases in like a Panel.',
			props: [
				{ name: 'icon', type: 'Component', description: 'Remix icon before the text.' },
				{
					name: 'ondismiss',
					type: '() => void',
					description: 'Shows a close button; the owner clears the cause.'
				},
				{
					name: 'dismissLabel',
					type: 'string',
					default: "'Dismiss'",
					description: 'Close button name.'
				},
				{ name: 'action', type: 'Snippet', description: 'One small control that fixes the cause.' }
			]
		},
		{
			name: 'ComposerAccessory.Panel',
			description:
				'Radius 2, one tier up, popover shadow. Rendered only while open; its height and opacity ease on open, close and when another panel replaces it, and it swaps instantly under reduced motion.',
			props: [
				{ name: 'value', type: 'string', description: 'Matches a Pill.' },
				{ name: 'label', type: 'string', description: 'Region name; also names the close button.' },
				{
					name: 'closable',
					type: 'boolean',
					default: 'true',
					description: 'Close button in the upper right.'
				},
				{
					name: 'tone',
					type: "'default' | 'xray' | 'seed'",
					default: "'default'",
					description:
						'xray: scanned header band and cool hairline. seed: the seed band (warm dots, accent top hairline). Content uses normal text tokens.'
				}
			]
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'Privacy pill',
			description: 'A pill under the composer opens a width-matched panel.'
		},
		{
			file: 'Notice',
			title: 'Notice on the composer',
			description:
				'A file refused, or a photo the chosen model won’t read: said on the composer’s top edge, not in the app-wide toast.'
		}
	]
} satisfies DocEntry;

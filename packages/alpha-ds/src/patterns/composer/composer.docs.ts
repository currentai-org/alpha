import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'composer',
	name: 'Composer',
	layer: 'pattern',
	description:
		'The message box: auto-growing input, tools row, accent send that becomes stop while streaming.',
	keywords: ['chat input', 'prompt', 'message box', 'send', 'textarea'],
	baseUi: null,
	anatomy: `<Composer.Root bind:value onsubmit busy onstop>
  <Composer.Input />
  <Composer.Toolbar>
    <Composer.Tools>
      <Composer.Chip icon={Globe} ondismiss>Web search</Composer.Chip>
    </Composer.Tools>
    <Composer.Send />
  </Composer.Toolbar>
</Composer.Root>`,
	parts: [
		{
			name: 'Composer.Root',
			description: 'Radius 2 (the spec’s one rounded input), Background 2.',
			props: [
				{ name: 'value', type: 'string', description: 'Draft. Bindable.' },
				{ name: 'onsubmit', type: '(value) => void', description: 'Enter / Send.' },
				{
					name: 'busy',
					type: 'boolean',
					default: 'false',
					description: 'Streaming — Send becomes Stop.'
				},
				{ name: 'onstop', type: '() => void', description: '' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' },
				{ name: 'above', type: 'Snippet', description: 'Attachments / notices above the box.' }
			]
		},
		{
			name: 'Composer.Input',
			description: 'Enter submits, Shift+Enter newline, IME-safe.',
			props: [{ name: 'placeholder', type: 'string', default: "'Ask anything'", description: '' }]
		},
		{ name: 'Composer.Toolbar / Tools', description: 'Row under the input; tools left.' },
		{
			name: 'Composer.Chip',
			description:
				'An active tool: quiet tinted pill, no outline, with a close button on its right edge that turns the tool off. Name only — no mode suffix.',
			props: [
				{ name: 'icon', type: 'Component', description: 'Tool glyph, drawn in Accent 1.' },
				{ name: 'ondismiss', type: '() => void', description: 'Close button pressed.' },
				{
					name: 'dismissLabel',
					type: 'string',
					default: "'Turn off'",
					description: 'Close button’s accessible name.'
				},
				{ name: 'disabled', type: 'boolean', default: 'false', description: '' }
			]
		},
		{ name: 'Composer.Send', description: 'Accent pill icon button.' }
	],
	examples: [
		{ file: 'Hero', title: 'With tools' },
		{ file: 'Busy', title: 'Streaming', description: 'Send turns into Stop.' }
	]
} satisfies DocEntry;

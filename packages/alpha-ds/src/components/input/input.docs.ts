import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'input',
	name: 'Input',
	layer: 'component',
	description:
		'A native text input on the recessed surface. Joins an enclosing Field automatically.',
	keywords: ['text field', 'form', 'textbox'],
	baseUi: { name: 'Input', url: 'https://base-ui.com/react/components/input' },
	anatomy: '<Input placeholder="Search" />',
	parts: [
		{
			name: 'Input',
			description: 'Native <input>; all input attributes pass through. `bind:value` supported.',
			engine: 'native <input>',
			props: [
				{
					name: 'size',
					type: "'sm' | 'md' | 'lg'",
					default: "'md'",
					description: 'Control height.'
				},
				{
					name: 'appearance',
					type: "'field' | 'bare' | 'code'",
					default: "'field'",
					description:
						'`bare` drops the box, for an input that is itself the surface (command palette, inline rename). `code` centres wide-tracked mono digits for one-time codes (sign-in); its placeholder clears while focused so the centred caret never splits it.'
				},
				{ name: 'value', type: 'string', description: 'Bindable.' }
			],
			dataAttributes: [
				{ name: 'data-invalid', description: 'Inside an invalid Field.' },
				{ name: 'data-disabled', description: 'Disabled.' }
			]
		}
	],
	examples: [{ file: 'Sizes', title: 'Sizes and states' }],
	guidelines: {
		do: ['Wrap in Field.Root for label/description/error wiring.'],
		dont: ['Round an input — Radius 2 is the chat composer only.']
	}
} satisfies DocEntry;

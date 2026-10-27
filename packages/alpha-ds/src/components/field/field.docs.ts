import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'field',
	name: 'Field',
	layer: 'component',
	description:
		'Groups a label, control, description and error, and wires ids, aria and state between them.',
	keywords: ['form', 'label', 'validation', 'error', 'helper text'],
	baseUi: { name: 'Field', url: 'https://base-ui.com/react/components/field' },
	deviations: [
		'No built-in validation engine (Base UI `validate`); pass `invalid` from your own logic.'
	],
	anatomy: `<Field.Root>
  <Field.Label />
  <Field.Control />
  <Field.Description />
  <Field.Error />
</Field.Root>`,
	parts: [
		{
			name: 'Field.Root',
			description: 'Provides ids and state.',
			props: [
				{
					name: 'invalid',
					type: 'boolean',
					default: 'false',
					description: 'Shows Error, marks the control.'
				},
				{
					name: 'disabled',
					type: 'boolean',
					default: 'false',
					description: 'Disables the control.'
				}
			],
			dataAttributes: [
				{ name: 'data-invalid', description: 'Invalid.' },
				{ name: 'data-disabled', description: 'Disabled.' }
			]
		},
		{ name: 'Field.Label', description: 'DM Mono label bound to the control.' },
		{
			name: 'Field.Control',
			description:
				'An Input. Any DS control (Textarea, Select.Trigger, Switch.Root…) also joins the field.'
		},
		{ name: 'Field.Description', description: 'Helper text, linked by aria-describedby.' },
		{
			name: 'Field.Error',
			description: 'Rendered only while invalid; role=alert.',
			props: [
				{
					name: 'forceShow',
					type: 'boolean',
					default: 'false',
					description: 'Show regardless of state.'
				}
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Label, help and error' }]
} satisfies DocEntry;

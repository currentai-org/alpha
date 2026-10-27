import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'textarea',
	name: 'Textarea',
	layer: 'component',
	description: 'Multi-line input that grows with its content, on the Input skin.',
	keywords: ['multiline', 'text area', 'form'],
	baseUi: null,
	deviations: [
		'Base UI has no Textarea; it renders one via Field.Control. This is a convenience part.'
	],
	anatomy: '<Textarea minRows={2} maxRows={8} />',
	parts: [
		{
			name: 'Textarea',
			description: 'Native <textarea> with `field-sizing: content`.',
			engine: 'native <textarea>',
			props: [
				{ name: 'minRows', type: 'number', default: '2', description: 'Rows before growing.' },
				{ name: 'maxRows', type: 'number', default: '8', description: 'Rows before scrolling.' },
				{ name: 'value', type: 'string', description: 'Bindable.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Auto-growing' }]
} satisfies DocEntry;

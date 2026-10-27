import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'stack',
	name: 'Stack',
	layer: 'primitive',
	description: 'Vertical flow with a token gap. The default way to lay out a column.',
	keywords: ['column', 'vstack', 'vertical', 'spacing', 'gap'],
	baseUi: null,
	anatomy: `<Stack gap="4">…</Stack>`,
	parts: [
		{
			name: 'Stack',
			description: 'flex-col.',
			props: [
				{
					name: 'gap',
					type: "'0' | '1' | '2' | '3' | '4' | '6' | '8' | '12'",
					default: "'4'",
					description: '4px units.'
				},
				{
					name: 'align',
					type: "'start' | 'center' | 'end' | 'stretch' | 'baseline'",
					default: "'stretch'",
					description: ''
				},
				{
					name: 'justify',
					type: "'start' | 'center' | 'end' | 'between'",
					default: "'start'",
					description: ''
				},
				{
					name: 'divided',
					type: 'boolean',
					default: 'false',
					description: 'Contextual rule between children.'
				},
				{ name: 'as', type: 'string', default: "'div'", description: '' }
			]
		}
	],
	examples: [{ file: 'Divided', title: 'Divided stack' }]
} satisfies DocEntry;

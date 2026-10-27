import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'visually-hidden',
	name: 'Visually Hidden',
	layer: 'primitive',
	description: 'Content for assistive technology only.',
	keywords: ['sr-only', 'screen reader', 'a11y', 'accessibility'],
	baseUi: null,
	anatomy: `<VisuallyHidden>Label</VisuallyHidden>`,
	parts: [
		{
			name: 'VisuallyHidden',
			description: 'sr-only.',
			props: [{ name: 'as', type: 'string', default: "'span'", description: '' }]
		}
	],
	examples: [{ file: 'Hero', title: 'Accessible name for an icon' }]
} satisfies DocEntry;

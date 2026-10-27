import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'kbd',
	name: 'Kbd',
	layer: 'component',
	description: 'A keyboard key, platform-aware for the modifier.',
	keywords: ['keyboard', 'shortcut', 'hotkey'],
	baseUi: null,
	anatomy: '<Kbd mod>K</Kbd>',
	parts: [
		{
			name: 'Kbd',
			description: '',
			props: [
				{ name: 'mod', type: 'boolean', default: 'false', description: 'Prefix ⌘ (Mac) or Ctrl.' }
			]
		}
	],
	examples: [{ file: 'Hero', title: 'Shortcuts' }]
} satisfies DocEntry;

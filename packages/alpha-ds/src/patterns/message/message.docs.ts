import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'message',
	name: 'Message',
	layer: 'pattern',
	description:
		'A conversation turn: user as a right-aligned Border 1 bubble, assistant as open full-width text.',
	keywords: ['chat', 'turn', 'bubble', 'reply', 'conversation'],
	baseUi: null,
	anatomy: `<Message.Root from="assistant">
  <Message.Content />
  <Message.Meta />
  <Message.Actions />
</Message.Root>`,
	parts: [
		{
			name: 'Message.Root',
			description: '',
			props: [{ name: 'from', type: "'user' | 'assistant'", description: 'Required.' }],
			dataAttributes: [{ name: 'data-from', description: '' }]
		},
		{ name: 'Message.Content', description: 'Bubble for user, open text for assistant.' },
		{ name: 'Message.Meta', description: 'Provenance line.' },
		{ name: 'Message.Actions', description: 'Icon row; appears on hover (always on touch).' }
	],
	examples: [{ file: 'Hero', title: 'An exchange' }]
} satisfies DocEntry;

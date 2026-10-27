import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'bento',
	name: 'Bento Tile',
	layer: 'pattern',
	description:
		'A landing tile: an icon, a headline and one line of copy over a live, playable scene. Used on /alpha.',
	keywords: ['bento', 'feature tile', 'card', 'landing', 'marketing', 'welcome', 'meet alpha'],
	baseUi: null,
	anatomy: `<BentoTile icon={RiTranslate2} title="…" body="…">
  …scene: real components, real data…
</BentoTile>`,
	parts: [
		{
			name: 'BentoTile',
			description:
				'Surface 2 card (rounded-card, hairline) with an accent glow rising behind the scene. The scene stays in the accessibility tree — it is meant to be used, not looked at.',
			props: [
				{ name: 'icon', type: 'Component', description: 'Remix icon, shown in the accent.' },
				{ name: 'title', type: 'string', description: 'type-title.' },
				{ name: 'body', type: 'string', description: 'One line, type-caption Text 2.' },
				{
					name: 'compact',
					type: 'boolean',
					default: 'BENTO_COMPACT context ?? false',
					description:
						'Shorter tile. A host sets `setContext(BENTO_COMPACT, true)` to shrink every tile inside it.'
				},
				{ name: 'sceneClass', type: 'string', description: 'Classes for the scene area.' },
				{ name: 'children', type: 'Snippet', description: 'The scene.' }
			]
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'Two tiles',
			description: 'Scenes are built from DS components, never screenshots.'
		}
	],
	guidelines: {
		do: [
			'Make the scene interactive and truthful — it demonstrates a real feature with real data.',
			'Keep the body to one line; the scene carries the explanation.'
		],
		dont: [
			'Put a screenshot or illustration in the scene.',
			'Nest a bordered card inside the tile — the tile is the container.'
		]
	}
} satisfies DocEntry;

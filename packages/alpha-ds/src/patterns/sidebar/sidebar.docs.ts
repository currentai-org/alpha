import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'sidebar',
	name: 'Sidebar',
	layer: 'pattern',
	description:
		'The regions of the conversation sidebar — header, primary actions, recents, footer — rail-aware.',
	keywords: ['navigation', 'nav', 'history', 'recents', 'conversations', 'rail'],
	baseUi: null,
	anatomy: `<Sidebar.Header />
<Sidebar.Actions>
  <Sidebar.Item emphasis />
</Sidebar.Actions>
<Sidebar.Content>
  <Sidebar.Section label="Today">
    <Sidebar.Item />
  </Sidebar.Section>
</Sidebar.Content>
<Sidebar.Footer />`,
	parts: [
		{
			name: 'Sidebar.Header',
			description: 'Collapse toggle (md+) / drawer close (mobile) + brand slot.',
			props: [
				{
					name: 'expandLabel',
					type: 'string',
					default: "'Expand sidebar'",
					description: 'Localized accessible label for expanding the rail.'
				},
				{
					name: 'collapseLabel',
					type: 'string',
					default: "'Collapse sidebar'",
					description: 'Localized accessible label for collapsing the sidebar.'
				},
				{
					name: 'closeLabel',
					type: 'string',
					default: "'Close sidebar'",
					description: 'Localized accessible label for the mobile close button.'
				}
			]
		},
		{ name: 'Sidebar.Actions', description: 'Primary actions list.' },
		{ name: 'Sidebar.Content', description: 'Scrolling middle; hidden in the rail.' },
		{
			name: 'Sidebar.Section',
			description: 'Labelled group.',
			props: [
				{ name: 'label', type: 'string', description: '' },
				{ name: 'action', type: 'Snippet', description: 'Right of the label.' }
			]
		},
		{
			name: 'Sidebar.Item',
			description: 'Nav row; icon-only with tooltip in the rail.',
			props: [
				{ name: 'href', type: 'string', description: 'Renders <a>.' },
				{ name: 'icon', type: 'Component', description: 'Remix icon.' },
				{ name: 'label', type: 'string', description: 'Plain text for tooltip/aria.' },
				{
					name: 'aria-label',
					type: 'string',
					description:
						"An accessible name that says more than the label; wins over the rail's label."
				},
				{
					name: 'current',
					type: 'boolean',
					default: 'false',
					description: 'Active tile (tint 15%).'
				},
				{
					name: 'emphasis',
					type: 'boolean',
					default: 'false',
					description: 'Nav type (DM Mono uppercase).'
				},
				{
					name: 'trailing',
					type: 'Snippet',
					description: 'Row actions, revealed on row hover or keyboard focus.'
				},
				{
					name: 'marker',
					type: 'Snippet',
					description:
						'Always-visible status chip, sitting left of `trailing` — for something true about the row whether or not the pointer is on it. The label reserves room for it, so a long title truncates before it rather than running underneath.'
				},
				{
					name: 'triggerProps',
					type: 'Record<string, unknown>',
					description:
						'Spread onto the row button — make a row a Menu/Popover trigger via their `child` snippet.'
				}
			]
		},
		{ name: 'Sidebar.Footer', description: 'Pinned bottom (settings, account).' }
	],
	examples: [{ file: 'Hero', title: 'Recents with row menu' }]
} satisfies DocEntry;

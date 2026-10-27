import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'app-shell',
	name: 'App Shell',
	layer: 'pattern',
	description:
		'The application frame: sidebar | conversation | side panel. Rail on desktop collapse, drawer on mobile.',
	keywords: ['layout', 'claude desktop', 'shell', 'frame', 'page structure', 'sidebar', 'drawer'],
	baseUi: null,
	anatomy: `<AppShell.Root bind:collapsed bind:sidePanelOpen>
  <AppShell.Sidebar>
    <Sidebar.Header />
    <Sidebar.Actions />
    <Sidebar.Content>
      <Sidebar.Section>
        <Sidebar.Item />
      </Sidebar.Section>
    </Sidebar.Content>
    <Sidebar.Footer />
  </AppShell.Sidebar>
  <AppShell.Main>
    <ThreadHeader />
    …conversation…
  </AppShell.Main>
  <AppShell.SidePanel />
</AppShell.Root>`,
	parts: [
		{
			name: 'AppShell.Root',
			description: 'Owns shell state; exposes it via getAppShell().',
			props: [
				{
					name: 'collapsed',
					type: 'boolean',
					default: 'false',
					description: 'Desktop rail. Bindable.'
				},
				{
					name: 'mobileOpen',
					type: 'boolean',
					default: 'false',
					description: 'Mobile drawer. Bindable.'
				},
				{
					name: 'sidePanelOpen',
					type: 'boolean',
					default: 'false',
					description: 'Right panel. Bindable.'
				}
			],
			dataAttributes: [{ name: 'data-sidebar', description: 'expanded | collapsed' }]
		},
		{
			name: 'AppShell.Sidebar',
			description:
				'In-flow (md+) or off-canvas drawer; Escape closes the drawer. On desktop the right edge is a resize handle: drag (or arrow keys on the focused handle) to resize between 208 and 480px, double-click to reset, drag well past the minimum to fold to the rail and drag the rail out to reopen.',
			props: [
				{
					name: 'resizable',
					type: 'boolean',
					default: 'true',
					description: 'Desktop drag handle on the right edge.'
				},
				{
					name: 'storageKey',
					type: 'string',
					default: "'alpha-ds:sidebar-width'",
					description: 'localStorage key the chosen width persists under (per browser).'
				},
				{ name: 'label', type: 'string', description: 'Accessible name of the sidebar landmark.' },
				{
					name: 'closeLabel',
					type: 'string',
					default: "'Close sidebar'",
					description: 'Localized accessible label for the mobile dismiss area.'
				},
				{
					name: 'resizeLabel',
					type: 'string',
					default: "'Resize sidebar'",
					description: 'Localized accessible label for the resize handle.'
				},
				{
					name: 'dragOpenLabel',
					type: 'string',
					default: "'Drag to open sidebar'",
					description: 'Localized accessible label for expanding a collapsed sidebar by dragging.'
				},
				{
					name: 'resizeTitle',
					type: 'string',
					default: "'Drag to resize · drag far left to collapse · double-click to reset'",
					description: 'Localized hover tooltip on the resize handle while the sidebar is open.'
				},
				{
					name: 'dragOpenTitle',
					type: 'string',
					default: "'Drag out to open'",
					description:
						'Localized hover tooltip on the resize handle while the sidebar is collapsed.'
				}
			],
			dataAttributes: [
				{ name: 'data-collapsed', description: '' },
				{ name: 'data-mobile-open', description: '' }
			]
		},
		{ name: 'AppShell.Main', description: 'Conversation column.' },
		{
			name: 'AppShell.SidePanel',
			description: 'Background 3 panel (XRAY, artifacts); full-screen sheet on mobile.'
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'Alpha shell',
			description:
				'Drag the sidebar edge to resize or fold it to the rail; collapse with the top-left button; resize below md for the drawer.'
		}
	]
} satisfies DocEntry;

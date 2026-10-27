import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'sheet',
	name: 'Sheet',
	layer: 'component',
	description:
		'A mobile-native bottom sheet with a grab handle, a shared header (title + close) and a scroll-faded body. Swipe down, tap the backdrop or press Escape to dismiss. Use `useCompact()` to swap a Popover, composer Panel or Dialog for a Sheet on phones.',
	keywords: ['bottom sheet', 'drawer', 'mobile', 'modal', 'action sheet'],
	baseUi: null,
	deviations: [
		'Alpha-only: Base UI has no sheet. Built on the Dialog engine (focus trap, Escape, scroll lock).'
	],
	anatomy: `<Sheet.Root bind:open>
  <Sheet.Portal>
    <Sheet.Backdrop />
    <Sheet.Popup>
      <Sheet.Header title="…" />
      <Sheet.Body>…</Sheet.Body>
    </Sheet.Popup>
  </Sheet.Portal>
</Sheet.Root>`,
	parts: [
		{
			name: 'Sheet.Root',
			description: 'Open state.',
			props: [{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' }]
		},
		{
			name: 'Sheet.Popup',
			description: 'Bottom-anchored, rounded top, max 90dvh, safe-area padding, drag to dismiss.'
		},
		{
			name: 'Sheet.Header',
			description: 'Title + close button; also a drag handle.',
			props: [{ name: 'title', type: 'string', description: 'Sheet title (the accessible name).' }]
		},
		{ name: 'Sheet.Body', description: 'Scrolling content with the scroll shadow.' },
		{ name: 'useCompact()', description: 'Reactive MediaQuery: `.current` is true below md.' }
	],
	examples: [{ file: 'Hero', title: 'Bottom sheet' }]
} satisfies DocEntry;

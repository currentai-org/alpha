import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'dialog',
	name: 'Dialog',
	layer: 'component',
	description:
		'A modal window over the page. Background 3, full-ink frame, hard shadow, focus trapped.',
	keywords: ['modal', 'popup', 'window', 'overlay'],
	baseUi: { name: 'Dialog', url: 'https://base-ui.com/react/components/dialog' },
	anatomy: `<Dialog.Root>
  <Dialog.Trigger />
  <Dialog.Portal>
    <Dialog.Backdrop />
    <Dialog.Popup>
      <Dialog.Title />
      <Dialog.Description />
      <Dialog.Close />
    </Dialog.Popup>
  </Dialog.Portal>
</Dialog.Root>`,
	parts: [
		{
			name: 'Dialog.Root',
			description: 'Owns open state.',
			engine: 'bits-ui Dialog.Root',
			props: [
				{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' },
				{ name: 'onOpenChange', type: '(open) => void', description: '' }
			]
		},
		{
			name: 'Dialog.Trigger',
			description: 'Styled as a Button (variant/size/shape).',
			engine: 'bits-ui Dialog.Trigger'
		},
		{
			name: 'Dialog.Portal',
			description:
				'Into the ThemeProvider’s body-level host — keeps theme and mode. Client-only: a portal renders nothing on the server, so a dialog open on first paint passes `disabled` to stay in the server’s HTML.',
			props: [
				{ name: 'container', type: 'HTMLElement | string', description: 'Override target.' },
				{
					name: 'disabled',
					type: 'boolean',
					default: 'false',
					description:
						'Render in place instead of portalling; use it for a dialog open on first paint.'
				}
			]
		},
		{
			name: 'Dialog.Backdrop',
			description: 'Scrim.',
			engine: 'bits-ui Dialog.Overlay',
			props: [
				{
					name: 'blur',
					type: 'boolean',
					default: 'false',
					description:
						'Onboarding modal only (the spec’s one blur): half the scrim’s dim and a soft blur, so the app shows through.'
				}
			]
		},
		{
			name: 'Dialog.Popup',
			description: 'The window; establishes surface 3.',
			engine: 'bits-ui Dialog.Content',
			props: [
				{
					name: 'size',
					type: "'sm' | 'md' | 'lg' | 'full'",
					default: "'md'",
					description:
						'Max width. `full` leaves sizing to the caller (only the viewport inset caps it).'
				},
				{
					name: 'placement',
					type: "'center' | 'top'",
					default: "'center'",
					description:
						'`top` anchors near the top so content grows downward (command palettes), capped at the space below the anchor.'
				},
				{
					name: 'padded',
					type: 'boolean',
					default: 'true',
					description: '`false` removes padding and gap — the content lays itself out.'
				}
			],
			dataAttributes: [{ name: 'data-open / data-closed (data-state)', description: '' }]
		},
		{
			name: 'Dialog.Title',
			description: 'DM Mono heading; names the dialog.',
			engine: 'bits-ui Dialog.Title'
		},
		{ name: 'Dialog.Description', description: '', engine: 'bits-ui Dialog.Description' },
		{
			name: 'Dialog.Close',
			description: 'No children → top-right icon close.',
			engine: 'bits-ui Dialog.Close'
		}
	],
	examples: [{ file: 'Hero', title: 'Basic dialog' }]
} satisfies DocEntry;

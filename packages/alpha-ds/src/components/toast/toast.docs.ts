import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'toast',
	name: 'Toast',
	layer: 'component',
	description: 'Brief, non-blocking notifications from a manager you can call anywhere.',
	keywords: ['notification', 'snackbar', 'alert', 'message'],
	baseUi: { name: 'Toast', url: 'https://base-ui.com/react/components/toast' },
	anatomy: `<Toast.Provider>
  <Toast.Viewport>
    <Toast.Root>
      <Toast.Title />
      <Toast.Description />
      <Toast.Close />
    </Toast.Root>
  </Toast.Viewport>
</Toast.Provider>`,
	parts: [
		{
			name: 'useToastManager()',
			description:
				'Returns the manager: `add({ title, description, type, timeout, action, onDismiss, testId })`, `update`, `close`, `dismiss` (runs `onDismiss`), `promise`, `pause` / `resume`.'
		},
		{
			name: 'Toast.Provider',
			description: 'Scopes a manager (defaults to the app-wide one).',
			props: [{ name: 'manager', type: 'ToastManager', description: '' }]
		},
		{
			name: 'Toast.Viewport',
			description:
				'Live region; portals to the theme host. Timers hold while the pointer or focus is on the stack; Escape dismisses the newest.',
			props: [
				{
					name: 'position',
					type: "'corner' | 'bottom-right' | 'bottom-center' | 'top-center'",
					default: "'bottom-right'",
					description:
						'`corner` is the app stack: bottom right on desktop (newest nearest the corner, lifted by `--toast-clearance`), full width along the top on phones (newest on top).'
				},
				{ name: 'max', type: 'number', default: '3', description: 'How many show at once.' },
				{ name: 'inline', type: 'boolean', default: 'false', description: 'Render in place.' },
				{ name: 'toast', type: 'Snippet<[ToastItem]>', description: 'Custom layout.' }
			]
		},
		{
			name: 'Toast.Root',
			description: 'One toast; type-coloured left rule.',
			dataAttributes: [{ name: 'data-type', description: 'default | success | error | loading' }]
		},
		{ name: 'Toast.Title / Description / Close', description: '' }
	],
	examples: [{ file: 'Hero', title: 'Types' }]
} satisfies DocEntry;

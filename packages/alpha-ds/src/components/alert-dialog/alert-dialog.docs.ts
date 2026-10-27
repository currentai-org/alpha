import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'alert-dialog',
	name: 'Alert Dialog',
	layer: 'component',
	description:
		'A dialog that demands a decision — outside clicks don’t dismiss it. For destructive confirmations.',
	keywords: ['confirm', 'destructive', 'delete', 'modal'],
	baseUi: { name: 'Alert Dialog', url: 'https://base-ui.com/react/components/alert-dialog' },
	deviations: [
		'Adds `AlertDialog.Action` (bits-ui’s confirming button) next to Base UI’s `Close`.'
	],
	anatomy: `<AlertDialog.Root>
  <AlertDialog.Trigger />
  <AlertDialog.Portal>
    <AlertDialog.Backdrop />
    <AlertDialog.Popup>
      <AlertDialog.Title />
      <AlertDialog.Description />
      <AlertDialog.Close />
      <AlertDialog.Action />
    </AlertDialog.Popup>
  </AlertDialog.Portal>
</AlertDialog.Root>`,
	parts: [
		{
			name: 'AlertDialog.Root',
			description: '',
			engine: 'bits-ui AlertDialog.Root',
			props: [{ name: 'open', type: 'boolean', default: 'false', description: 'Bindable.' }]
		},
		{ name: 'AlertDialog.Trigger', description: 'Styled as a Button.' },
		{
			name: 'AlertDialog.Portal / Backdrop / Popup / Title / Description',
			description: 'As Dialog.'
		},
		{
			name: 'AlertDialog.Close',
			description: 'Dismiss without acting (secondary).',
			engine: 'bits-ui AlertDialog.Cancel'
		},
		{
			name: 'AlertDialog.Action',
			description: 'Confirm (primary by default).',
			engine: 'bits-ui AlertDialog.Action'
		}
	],
	examples: [{ file: 'Hero', title: 'Forget everything' }],
	guidelines: {
		do: ['Name the consequence in the title.'],
		dont: ['Make the confirming button red — the destructive icon carries the signal.']
	}
} satisfies DocEntry;

import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'attachment',
	name: 'Attachment',
	layer: 'pattern',
	description:
		'Files attached to a message: a square thumbnail for a photo, a card with its type and name for anything else, in one row inside the composer or above a sent message.',
	keywords: ['file', 'upload', 'photo', 'image', 'thumbnail', 'document', 'pdf', 'paste'],
	baseUi: null,
	anatomy: `<Attachment.Row aria-label="Attached files">
  <Attachment.Card name="receipt.jpg" imageSrc={url} onremove={…} />
  <Attachment.Card name="notes.pdf" kind="PDF" onopen={…} onremove={…} />
</Attachment.Row>`,
	parts: [
		{
			name: 'Attachment.Row',
			description:
				'One line of cards that scrolls sideways and fades at the edge with more. Inside the composer it is the first thing in the box, above the text.',
			engine: 'native <div>',
			props: [
				{
					name: 'aria-label',
					type: 'string',
					description: 'Names the group, e.g. "Attached files".'
				},
				{ name: 'class', type: 'string', description: 'Layout only.' }
			],
			dataAttributes: [{ name: 'data-attachment-row', description: 'Always present.' }]
		},
		{
			name: 'Attachment.Card',
			description:
				'A 64px-high tile one tier up from the surface behind it, unbordered. With `imageSrc` it is a square thumbnail cropped to fill; otherwise a 168px card with the icon and type above the name, which wraps to two lines.',
			engine: 'native <div> + <button>',
			props: [
				{
					name: 'name',
					type: 'string',
					description: 'File name: the card text and the photo’s alt text.'
				},
				{ name: 'kind', type: 'string', description: 'Type shown above the name ("PDF", "Text").' },
				{
					name: 'imageSrc',
					type: 'string',
					description: 'A photo’s thumbnail. Makes the card square.'
				},
				{
					name: 'icon',
					type: 'Component',
					default: 'RiFileTextLine',
					description: 'Remix icon before the type.'
				},
				{
					name: 'busy',
					type: 'boolean',
					default: 'false',
					description: 'Covers the card with a spinner while the file is prepared.'
				},
				{
					name: 'busyLabel',
					type: 'string',
					default: "'Preparing'",
					description: 'Accessible name of the spinner.'
				},
				{
					name: 'onopen',
					type: '() => void',
					description: 'Makes the card a button that opens a preview.'
				},
				{
					name: 'openLabel',
					type: 'string',
					description: 'Accessible name of that button. Defaults to "Open <name>".'
				},
				{
					name: 'onremove',
					type: '() => void',
					description: 'Shows the remove button in the top corner.'
				},
				{
					name: 'removeLabel',
					type: 'string',
					description: 'Accessible name of the remove button. Defaults to "Remove <name>".'
				},
				{ name: 'class', type: 'string', description: 'Layout only.' }
			],
			dataAttributes: [
				{ name: 'data-attachment', description: '`"image"` or `"file"`.' },
				{ name: 'data-busy', description: 'Present while `busy`.' }
			]
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'In the composer',
			description: 'A photo, a PDF, a text file and a photo still being prepared, above the draft.'
		}
	],
	guidelines: {
		do: [
			'Put the row inside the composer box, above the text, so the files read as part of the message.',
			'Use the same cards above a sent message, without `onremove`.',
			'Name the type in words with `kind` ("PDF"), never as a MIME type.'
		],
		dont: [
			'Add a border or a shadow: the fill one tier up is the whole edge.',
			'Hide the remove button from touch screens; it shows there without hover.',
			'Use it for a file the person did not attach, such as a source the answer cites.'
		]
	}
} satisfies DocEntry;

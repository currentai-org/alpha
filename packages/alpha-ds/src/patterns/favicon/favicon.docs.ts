import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'favicon',
	name: 'Favicon',
	layer: 'pattern',
	description:
		'The icon of the site a link points to, at the start of the link, so a list of sources reads by site at a glance. Falls back to a globe.',
	keywords: ['site icon', 'link', 'source', 'url', 'domain', 'globe'],
	baseUi: null,
	anatomy: `<a class="inline-flex items-center gap-1.5">
  <Favicon src={faviconSrc(url)} />
  {title}
</a>`,
	parts: [
		{
			name: 'Favicon',
			description:
				'A decorative `<img>`, lazy-loaded with no referrer. With no `src`, or when the image fails, it draws a globe in the same box, so links in a list keep one left edge. In the app, build `src` with `faviconSrc(url)` from `$lib/favicon`: it asks our own `/api/favicon` route, never the site.',
			engine: 'native <img>',
			props: [
				{
					name: 'src',
					type: 'string | null',
					description: 'Image URL for the icon. Unset or failing to load draws the globe.'
				},
				{
					name: 'size',
					type: "'xs' | 'sm' | 'md'",
					default: "'sm'",
					description: '12, 14 or 16px — match the cap height of the link beside it.'
				},
				{ name: 'class', type: 'string', description: 'Layout only.' }
			],
			dataAttributes: [
				{
					name: 'data-favicon',
					description: 'Empty on the site’s icon; `"fallback"` on the globe.'
				}
			]
		}
	],
	examples: [
		{
			file: 'Hero',
			title: 'In a sources list',
			description: 'Each source leads with its site’s icon; one without an icon gets the globe.'
		}
	],
	guidelines: {
		do: [
			'Put it before the link text, inside the same flex row, with `items-center`.',
			'Use it for links to pages we retrieved or someone gave us: sources, credits, pasted links.',
			'Keep the link text: the icon is decorative and has no accessible name.'
		],
		dont: [
			'Point `src` at the site directly; go through `faviconSrc`, so showing a link never contacts its site.',
			'Add it to links the model wrote in an answer: those are untrusted, and loading anything for them on sight is a request the page author chose.',
			'Use it as a button or the only content of a link.'
		]
	}
} satisfies DocEntry;

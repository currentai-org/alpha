import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'avatar',
	name: 'Avatar',
	layer: 'component',
	description: 'A square user image with a DM Mono initials fallback.',
	keywords: ['user', 'profile', 'image', 'initials'],
	baseUi: { name: 'Avatar', url: 'https://base-ui.com/react/components/avatar' },
	anatomy: `<Avatar.Root>
  <Avatar.Image />
  <Avatar.Fallback />
</Avatar.Root>`,
	parts: [
		{
			name: 'Avatar.Root',
			description: 'Frame.',
			engine: 'bits-ui Avatar.Root',
			props: [{ name: 'size', type: "'sm' | 'md' | 'lg'", default: "'md'", description: '' }]
		},
		{ name: 'Avatar.Image', description: 'Shown once loaded.', engine: 'bits-ui Avatar.Image' },
		{
			name: 'Avatar.Fallback',
			description: 'Shown until/unless the image loads.',
			engine: 'bits-ui Avatar.Fallback'
		}
	],
	examples: [{ file: 'Hero', title: 'Sizes' }]
} satisfies DocEntry;

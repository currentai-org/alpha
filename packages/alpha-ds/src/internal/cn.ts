/**
 * Class composition for the design system.
 *
 * tailwind-merge only knows Tailwind's default theme, so out of the box it would read our
 * `text-body` (a font SIZE) as a text COLOUR and silently drop a `text-fg-2` next to it. The merge
 * config below is derived from the token sources, so a new size, colour or type role is
 * understood the moment it exists — nothing to keep in sync by hand.
 */
import { clsx, type ClassValue } from 'clsx';
import {
	extendTailwindMerge,
	type ConfigExtension,
	type DefaultClassGroupIds,
	type DefaultThemeGroupIds
} from 'tailwind-merge';
import { createTV } from 'tailwind-variants';
import { TAILWIND_COLORS } from '../tokens/tailwind-map.ts';
import { controlSizes, radii, textSizes, typeStyles, xray, zIndex } from '../tokens/scales.ts';

export const twMergeConfig: ConfigExtension<
	DefaultClassGroupIds | 'ds-type',
	DefaultThemeGroupIds
> = {
	extend: {
		theme: {
			color: [...Object.keys(TAILWIND_COLORS), ...Object.keys(xray).map((k) => `xray-${k}`)],
			text: Object.keys(textSizes),
			radius: Object.keys(radii),
			spacing: [
				...Object.keys(controlSizes).map((k) => `control-${k}`),
				'sidebar',
				'rail',
				'header',
				'side-panel',
				'site-header'
			],
			container: ['thread'],
			shadow: ['window', 'popover'],
			ease: ['standard', 'exit']
		},
		classGroups: {
			'ds-type': [{ type: Object.keys(typeStyles) }],
			z: [{ z: Object.keys(zIndex) }]
		}
	}
};

const merge = extendTailwindMerge<'ds-type'>(twMergeConfig);

/** Merge class values; later classes win conflicts (the consumer's `class` prop comes last). */
export function cn(...inputs: ClassValue[]): string {
	return merge(clsx(inputs));
}

/** `tv()` preconfigured with the same merge rules — use this for every component recipe. */
export const tv = createTV({ twMergeConfig });

export type { VariantProps } from 'tailwind-variants';
export type { ClassValue };

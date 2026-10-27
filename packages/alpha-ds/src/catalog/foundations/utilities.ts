/**
 * Every hand-authored utility in tokens/utilities.css, documented for the Utilities foundation page.
 * registry.spec.ts parses the CSS and fails when a `@utility` is missing here (or listed here but
 * gone), so a new utility cannot ship undocumented.
 *
 * `preview` is a class string applied to a sample box on the page (literal, so Tailwind sees it).
 */
export interface UtilityDoc {
	name: string;
	description: string;
	preview?: 'tint' | 'mask' | 'scroll' | 'xray' | 'seed' | 'bar' | 'swatch';
	previewClass?: string;
}

export const UTILITY_GROUPS: { title: string; lead: string; items: UtilityDoc[] }[] = [
	{
		title: 'Interaction',
		lead: 'Hover and press darken the rest-state fill with an ink tint layered over it — never a colour swap.',
		items: [
			{
				name: 'tint-subtle',
				description: 'Faintest ink tint — selected rows, quiet emphasis.',
				preview: 'tint',
				previewClass: 'tint-subtle'
			},
			{
				name: 'tint-hover',
				description: 'Hover state over any fill.',
				preview: 'tint',
				previewClass: 'tint-hover'
			},
			{
				name: 'tint-active',
				description: 'Pressed / open state.',
				preview: 'tint',
				previewClass: 'tint-active'
			},
			{
				name: 'transition-control',
				description:
					'The one transition for interactive parts: colour, fill, border, opacity, shadow — token durations.'
			}
		]
	},
	{
		title: 'Motion',
		lead: 'Enter/exit keyed off data-state / data-open. All collapse to nothing under reduced motion — see Motion.',
		items: [
			{ name: 'motion-popup', description: 'Menus, popovers, tooltips: 90ms fade + 2px nudge.' },
			{
				name: 'motion-dialog',
				description: 'Centred dialogs: scale from the centre. Never animates translate.'
			},
			{ name: 'motion-sheet', description: 'Bottom sheets: slide up from the edge, back down.' },
			{ name: 'motion-fade', description: 'Backdrops and overlays.' },
			{ name: 'motion-collapse', description: 'Accordion / collapsible height.' },
			{
				name: 'route-notice',
				description:
					'One-shot notice on a pill, played each time data-noticing is set (clear it on animationend): an accent band crosses, the hairline flares, the leading icon turns. Not while open; off under reduced motion. The model picker plays it when Auto’s read changes.'
			}
		]
	},
	{
		title: 'Masks & scrolling',
		lead: 'Content fades at edges instead of being cut off. Put scroll-fade on the element that scrolls.',
		items: [
			{
				name: 'scroll-fade-y',
				description:
					'Vertical scroll shadow; each edge fades only while there is more to scroll that way. Fade length: the scroll-fade custom property (32px default).',
				preview: 'scroll',
				previewClass: 'scroll-fade-y'
			},
			{ name: 'scroll-fade-x', description: 'The same, horizontally (chip rows, carousels).' },
			{
				name: 'mask-fade-radial',
				description:
					'Soft vignette — decorative layers that blend into the surface (new-chat backdrop).',
				preview: 'mask',
				previewClass: 'mask-fade-radial'
			},
			{
				name: 'mask-fade-bottom',
				description: 'Fades a decorative layer out toward its bottom edge (sign-in brand band).',
				preview: 'mask',
				previewClass: 'mask-fade-bottom'
			},
			{
				name: 'no-scrollbar',
				description:
					'Hide the scrollbar on a scroller that has its own dots/arrows. Still scrollable.'
			}
		]
	},
	{
		title: 'XRAY',
		lead: 'The XRAY identity — cool scan grid, ring and sweep. Colours come from the xray token family.',
		items: [
			{
				name: 'xray-band',
				description: 'Panel header band: a scan grid fading out downward (::before, 96px).',
				preview: 'xray',
				previewClass: 'xray-band'
			},
			{
				name: 'xray-grid',
				description: '14px scan grid background.',
				preview: 'xray',
				previewClass: 'xray-grid'
			},
			{
				name: 'xray-halo',
				description: 'Open-state ring with a soft cool glow.',
				preview: 'xray',
				previewClass: 'xray-halo'
			},
			{
				name: 'xray-body',
				description:
					'Panel tab body height: 24rem on tall windows, shrinking with a short one so the answer stays in view (never under 10rem). Capped by `--xray-body-max` when the panel gives height back so the answer footer fits above it.'
			},
			{
				name: 'xray-sweep',
				description:
					'Light sweep across the entry pill every few seconds, its hairline flaring as it passes (not while open); off under reduced motion.',
				preview: 'xray',
				previewClass: 'xray-sweep'
			}
		]
	},
	{
		title: 'Growth',
		lead: 'Where Alpha is still learning — a language no model handles well yet. Warm and sown where XRAY is cool and ruled; colour is the theme accent.',
		items: [
			{
				name: 'seed-band',
				description:
					'Top band of offset accent dots and a corner glow fading downward (::before, 56px), with an accent hairline along the top edge (::after).',
				preview: 'seed',
				previewClass: 'seed-band'
			}
		]
	},
	{
		title: 'Data & user colour',
		lead: 'Values that come from data or from the person, passed in as a custom property.',
		items: [
			{
				name: 'bar-width',
				description: 'Inline data bar: `style:--bar-width="60%"`.',
				preview: 'bar',
				previewClass: 'bar-width'
			},
			{ name: 'bar-offset', description: 'Bar start: `style:--bar-offset="20%"` (ranges).' },
			{
				name: 'bg-swatch',
				description:
					'A user-chosen colour (theme builder): `style:--swatch={colour}`. The one place a raw colour reaches the UI.',
				preview: 'swatch',
				previewClass: 'bg-swatch'
			}
		]
	}
];

export const DOCUMENTED_UTILITIES = UTILITY_GROUPS.flatMap((g) => g.items.map((i) => i.name));

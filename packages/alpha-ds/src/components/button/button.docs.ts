import type { DocEntry } from '../../catalog/types.ts';

export default {
	slug: 'button',
	name: 'Button',
	layer: 'component',
	description:
		'A native button (or link) in six spec-defined variants. Every trigger part reuses this skin.',
	keywords: ['action', 'cta', 'link', 'icon button', 'send'],
	baseUi: { name: 'Button', url: 'https://base-ui.com/react/components/button' },
	deviations: [
		"`href` renders an <a> instead of Base UI's `render` prop.",
		'Variants/sizes are Alpha additions; Base UI ships unstyled.'
	],
	anatomy: '<Button variant="secondary" size="md">Label</Button>',
	parts: [
		{
			name: 'Button',
			description: 'Renders <button>, or <a> when `href` is set.',
			engine: 'native <button> / <a>',
			props: [
				{
					name: 'variant',
					type: "'primary' | 'secondary' | 'ghost' | 'destructive' | 'accent' | 'link'",
					default: "'secondary'",
					description: 'Visual role. `accent` is icon sizes only.'
				},
				{
					name: 'size',
					type: "'xs' | 'sm' | 'md' | 'lg' | 'icon-xs' | 'icon-sm' | 'icon' | 'icon-lg'",
					default: "'md'",
					description: 'Control height; icon-* are square.'
				},
				{
					name: 'shape',
					type: "'sharp' | 'pill' | 'field'",
					default: "'sharp'",
					description: 'Radius tier. `pill` only for in-chat CTAs.'
				},
				{
					name: 'block',
					type: 'boolean',
					default: 'false',
					description: 'Full width, label centred — sheet, dialog and sign-in actions.'
				},
				{
					name: 'casing',
					type: "'upper' | 'sentence'",
					default: "'upper'",
					description:
						"`upper` is the spec's CTA type (DM Mono uppercase); `sentence` is Font 1 for controls that carry content (a title, a model name). Also on every Trigger part."
				},
				{ name: 'href', type: 'string', description: 'Render as a link.' },
				{ name: 'disabled', type: 'boolean', default: 'false', description: 'Flat opacity-40.' },
				{
					name: 'focusableWhenDisabled',
					type: 'boolean',
					default: 'false',
					description: 'Keep focusable while disabled (for tooltips).'
				}
			],
			dataAttributes: [{ name: 'data-disabled', description: 'Present when disabled.' }]
		}
	],
	examples: [
		{ file: 'Variants', title: 'Variants' },
		{
			file: 'Surfaces',
			title: 'On every surface',
			description:
				'Rest fill is one tier up from whatever it sits on — resolved by the surface context, not by the caller.'
		},
		{ file: 'Sizes', title: 'Sizes and icon buttons' },
		{
			file: 'Destructive',
			title: 'Destructive',
			description: 'Looks like secondary; only the icon carries Accent 2.'
		}
	],
	guidelines: {
		do: [
			'One `primary` per view.',
			'Use `ghost` for nav/utility icons — the tint tile is the affordance.',
			'Keep labels left-aligned; prefer nowrap.'
		],
		dont: [
			'Put `accent` on a labelled button — accent is never a surface fill.',
			"Colour a destructive button's border or text red."
		]
	}
} satisfies DocEntry;

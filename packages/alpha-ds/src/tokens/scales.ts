/**
 * Structural tokens — the mode-independent half of the system (size, shape, type, motion).
 *
 * SOURCE OF TRUTH. Edit here, then run `pnpm ds:tokens` to regenerate `generated/tokens.css`
 * and `generated/tokens.json`. `tokens.spec.ts` fails if the checked-in output drifts.
 *
 * Values follow the CF Alpha spec (`src/lib/chat/design-system.md`, CUR-509): three radius
 * tiers, a six-step type scale, three typefaces with one job each. Brutalism lives here as
 * much as in colour: sharp by default, hard 1px rules, no soft elevation, fast linear motion.
 *
 * Kept to erasable TypeScript (no enums/namespaces) so Node can import it directly.
 */

/** Typefaces — Font 1/2/3 in the spec. */
export const fonts = {
	/** Font 1 — everything by default. */
	sans: '"Plus Jakarta Sans", ui-sans-serif, system-ui, sans-serif',
	/** Font 2 — technical/meta: uppercase tracked labels, tags, panel titles, CTAs. */
	mono: '"DM Mono", ui-monospace, "SFMono-Regular", monospace',
	/** Font 3 — display headlines only. */
	serif: '"Noto Serif", Georgia, "Times New Roman", serif'
} as const;

/**
 * UI type — the voice of controls and meta labels (the label, nav, cta and heading roles). The
 * brutalist default is DM Mono in uppercase; a theme can swap both (see `structure` in themes.ts),
 * which is most of what separates a brutalist theme from a soft one.
 */
export const uiType = {
	font: 'var(--ds-font-mono)',
	case: 'uppercase'
} as const;

export const fontWeights = {
	regular: '400',
	medium: '500',
	semibold: '600',
	bold: '700'
} as const;

/**
 * Six-step size scale (Size 1–6). Each step carries its default line-height so a size utility is
 * always a complete, readable pairing. Round a new design to the nearest step; do not add one.
 */
export const textSizes = {
	micro: { size: '10px', lineHeight: '14px' },
	small: { size: '12px', lineHeight: '18px' },
	body: { size: '14px', lineHeight: '22px' },
	subhead: { size: '16px', lineHeight: '24px' },
	heading: { size: '20px', lineHeight: '28px' },
	display: { size: '34px', lineHeight: '40px' }
} as const;

export const tracking = {
	tight: '-0.03em',
	normal: '0',
	label: '0.05em',
	wide: '0.08em'
} as const;

/**
 * Composite type styles — the spec's "Type scale" table as named roles. Emitted as Tailwind
 * `type-*` utilities; reach for these before composing font + size + tracking by hand.
 */
export const typeStyles = {
	/** Top-bar tags, meta labels: DM Mono 10 medium uppercase. */
	label: { font: 'ui', size: 'micro', weight: 'medium', tracking: 'label', uppercase: true },
	/** Nav items, panel titles: DM Mono 14 medium uppercase, 30px rows. */
	nav: {
		font: 'ui',
		size: 'body',
		weight: 'medium',
		tracking: 'label',
		uppercase: true,
		lineHeight: '30px'
	},
	/** CTA buttons: DM Mono 12 uppercase, wide tracking. */
	cta: { font: 'ui', size: 'small', weight: 'medium', tracking: 'wide', uppercase: true },
	/** Captions and helper text. */
	caption: { font: 'sans', size: 'small', weight: 'regular', tracking: 'normal' },
	/** Default reading text. */
	body: { font: 'sans', size: 'body', weight: 'regular', tracking: 'normal' },
	/** Card titles: Jakarta 16 bold. */
	title: { font: 'sans', size: 'subhead', weight: 'bold', tracking: 'normal' },
	/** Inline section headings: DM Mono 20 medium, tight. */
	heading: { font: 'ui', size: 'heading', weight: 'medium', tracking: 'tight' },
	/** One place per surface: Noto Serif display. */
	display: { font: 'serif', size: 'display', weight: 'regular', tracking: 'tight' },
	/** Inline code, token names, technical values. */
	code: { font: 'mono', size: 'small', weight: 'regular', tracking: 'normal' }
} as const satisfies Record<
	string,
	{
		font: keyof typeof fonts | 'ui';
		size: keyof typeof textSizes;
		weight: keyof typeof fontWeights;
		tracking: keyof typeof tracking;
		uppercase?: boolean;
		lineHeight?: string;
	}
>;

/**
 * Radius tiers (Radius 1/2/3). Sharp is the default for everything; `field` is the composer and
 * prompt-example buttons only; `pill` is small in-chat CTAs only (send, toggle pills).
 */
/*
 * Default (Alpha) corners are slightly rounded, softening the
 * all-square brutalist spec. Themes still override every tier; Mistral and the custom
 * builder's "Sharp" option keep square corners.
 */
export const radii = {
	sharp: '4px',
	field: '10px',
	pill: '9999px',
	/** Menus / popovers: `sharp` + their 4px inner padding, so rows' hover corners sit concentric. */
	popup: '8px',
	/** Containers — cards, grouped settings, list boxes, tiles. */
	card: '8px'
} as const;

export const borderWidths = {
	/** Hairline rules, card outlines. */
	hairline: '1px',
	/** Brutalist frames: the outer window, the primary button outline. */
	strong: '2px'
} as const;

/** Spacing — a 4px grid, mirrored from Tailwind's `--spacing` so CSS and utilities agree. */
export const spaceUnit = '0.25rem';
export const space = {
	'0': '0px',
	px: '1px',
	'0.5': '2px',
	'1': '4px',
	'1.5': '6px',
	'2': '8px',
	'3': '12px',
	'4': '16px',
	'5': '20px',
	'6': '24px',
	'8': '32px',
	'10': '40px',
	'12': '48px',
	'16': '64px'
} as const;

/** Control heights — every interactive control snaps to one of these. */
export const controlSizes = {
	xs: '24px',
	sm: '28px',
	md: '32px',
	lg: '40px'
} as const;

/** Layout dimensions used by the patterns layer (chat-app proportions). */
export const layout = {
	'sidebar-width': '16.5rem',
	'sidebar-rail-width': '3.25rem',
	'header-height': '2.75rem',
	'thread-width': '46rem',
	'side-panel-width': '26rem',
	'composer-max-height': '40vh'
} as const;

/**
 * Motion — brutalism reads as immediate. Durations are short and exits faster than entrances;
 * `reduce` collapses everything to 0 under `prefers-reduced-motion`.
 */
export const motion = {
	'duration-instant': '0ms',
	'duration-fast': '90ms',
	'duration-base': '140ms',
	'duration-slow': '220ms',
	'ease-standard': 'cubic-bezier(0.2, 0, 0, 1)',
	'ease-exit': 'cubic-bezier(0.4, 0, 1, 1)',
	'ease-linear': 'linear'
} as const;

/** Stacking layers — pick a named layer; never a raw z-index. */
export const zIndex = {
	base: '0',
	raised: '1',
	sticky: '10',
	header: '20',
	overlay: '40',
	popover: '50',
	toast: '60',
	tooltip: '70'
} as const;

/**
 * Focus — every interactive control shows a 2px ring on :focus-visible (spec §1). The colour is
 * semantic (`--ds-focus`, contrast-solved per mode).
 */
export const focus = {
	width: '2px',
	offset: '2px'
} as const;

/**
 * Elevation — the system is flat. `window` is the single permanent shadow (the outer app
 * container, spec §4); `popover` is a hard brutalist offset used only by floating layers so they
 * separate from the page without a blur.
 */
/**
 * XRAY — a restrained identity, not a costume: one cool "radiograph" hue used for the entry mark,
 * small labels, a hairline and a faint scan grid in the panel's header band. Content inside XRAY uses
 * the normal text tokens, so it reads exactly like the rest of the app. Follows light/dark; `glow` is
 * chosen for AA contrast as small text on the raised surface in both modes.
 */
export const xray = {
	glow: 'light-dark(oklch(0.5 0.13 245), oklch(0.8 0.1 220))',
	tint: 'light-dark(oklch(0.6 0.12 240 / 0.08), oklch(0.78 0.11 220 / 0.1))',
	line: 'light-dark(oklch(0.55 0.12 240 / 0.3), oklch(0.78 0.11 220 / 0.3))',
	grid: 'light-dark(oklch(0.55 0.1 240 / 0.08), oklch(0.78 0.1 220 / 0.07))'
} as const;

export const shadows = {
	none: 'none',
	window: '0 1px 0 0 var(--ds-line-1), 0 24px 48px -24px oklch(0 0 0 / 0.35)',
	/** Floating layers: a hairline plus a soft, low-contrast lift — no hard offset edge. */
	popover:
		'0 0 0 1px var(--ds-line-1), 0 2px 4px -1px oklch(0 0 0 / 0.12), 0 12px 28px -10px oklch(0 0 0 / 0.35)'
} as const;

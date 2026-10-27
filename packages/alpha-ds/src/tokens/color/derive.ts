/**
 * Seeds → semantic colour ladder. One pure function, run per mode.
 *
 * Surface tiers are lightness offsets from one background seed, text tiers are the ink seed
 * stepped toward the background and then CONTRAST-SOLVED so a seed change can never ship unreadable text, and
 * accent/status colours get a separate text-safe variant.
 */
import type { ModeSeeds, ThemeSeeds } from '../themes.ts';
import {
	contrast,
	hexToOklch,
	mix,
	type Oklch,
	shiftL,
	solveContrast,
	toGamut,
	withAlpha
} from './oklch.ts';

export type Mode = 'light' | 'dark';

/** WCAG targets the engine enforces. Tests assert these hold for every shipped theme. */
export const CONTRAST_TARGETS = {
	/** Text 1 on every background tier. */
	'fg-1': 7,
	/** Text 2 on every background tier — AA body text. */
	'fg-2': 4.5,
	/** Text 3 on Background 1/2 — AA body text; Text 3 is bumped for reading. */
	'fg-3': 4.5,
	/** Accent / status colours used as text, on every tier. */
	'accent-text': 4.5,
	/** Glyphs on an accent fill (send button) — non-text UI contrast, WCAG 1.4.11. */
	'on-accent': 4.5,
	/** Focus ring against Background 1. */
	focus: 3
} as const;

export interface SemanticToken {
	name: string;
	group: 'surface' | 'text' | 'line' | 'accent' | 'status' | 'tint' | 'utility';
	description: string;
}

/** Every semantic colour token, in display order. `--ds-<name>` in CSS. */
export const SEMANTIC_TOKENS: readonly SemanticToken[] = [
	{ name: 'bg-1', group: 'surface', description: 'Background 1 — the main app surface.' },
	{
		name: 'bg-2',
		group: 'surface',
		description: 'Background 2 — inset/recessed content (cards, composer). Darker.'
	},
	{
		name: 'bg-3',
		group: 'surface',
		description: 'Background 3 — floating panels, popovers. Lighter.'
	},
	{
		name: 'bg-chrome',
		group: 'surface',
		description: 'Window chrome (top bar). The only surface outside the three tiers.'
	},
	{
		name: 'bg-inverse',
		group: 'surface',
		description: 'Inverted surface for the rare transient overlay (tooltip).'
	},
	{ name: 'fg-1', group: 'text', description: 'Text 1 — primary text and icons.' },
	{ name: 'fg-2', group: 'text', description: 'Text 2 — supporting copy.' },
	{
		name: 'fg-3',
		group: 'text',
		description: 'Text 3 — least important text; still AA on Background 1/2.'
	},
	{ name: 'fg-on-chrome', group: 'text', description: 'Text on the chrome surface.' },
	{ name: 'fg-inverse', group: 'text', description: 'Text on bg-inverse.' },
	{
		name: 'fg-on-accent',
		group: 'text',
		description: 'Glyph on an accent-filled icon control (send).'
	},
	{ name: 'line-1', group: 'line', description: 'Border 1 — very subtle; message outlines.' },
	{
		name: 'line-2',
		group: 'line',
		description: 'Border 2 — the default rule for boxes, cards, layout lines.'
	},
	{
		name: 'line-3',
		group: 'line',
		description: 'Border 3 — rules on Background 3, where Border 2 would vanish.'
	},
	{
		name: 'line-strong',
		group: 'line',
		description: 'Full-ink brutalist frame (outer window, primary outline).'
	},
	{
		name: 'accent-1',
		group: 'accent',
		description: 'Accent 1 — the one primary action. Icon/badge scale only.'
	},
	{
		name: 'accent-1-hover',
		group: 'accent',
		description: 'Accent 1 pressed/hover fill (flat step, spec: opacity drop).'
	},
	{
		name: 'accent-1-text',
		group: 'accent',
		description: 'Accent 1 when it must be read as text (links, labels).'
	},
	{ name: 'accent-2', group: 'accent', description: 'Accent 2 — destructive actions only.' },
	{ name: 'accent-2-hover', group: 'accent', description: 'Accent 2 pressed/hover fill.' },
	{
		name: 'accent-2-text',
		group: 'accent',
		description: 'Accent 2 as readable text (error messages).'
	},
	{ name: 'positive', group: 'status', description: 'Healthy / live status mark.' },
	{ name: 'positive-text', group: 'status', description: 'Positive status as readable text.' },
	{ name: 'caution', group: 'status', description: 'Fragile / building status mark.' },
	{ name: 'caution-text', group: 'status', description: 'Caution status as readable text.' },
	{ name: 'tint-subtle', group: 'tint', description: 'Row hover wash (lists, menu items).' },
	{ name: 'tint-hover', group: 'tint', description: 'Icon-button hover tile (spec: ink @ 15%).' },
	{
		name: 'tint-active',
		group: 'tint',
		description: 'Icon-button active/selected tile (spec: ink @ 30%).'
	},
	{ name: 'focus', group: 'utility', description: 'Focus-visible ring colour.' },
	{ name: 'overlay', group: 'utility', description: 'Modal backdrop scrim.' },
	{ name: 'selection', group: 'utility', description: 'Text selection highlight.' },
	{ name: 'grid', group: 'utility', description: 'Decorative grid lines (backdrops, stack map).' }
] as const;

export type SemanticName = (typeof SEMANTIC_TOKENS)[number]['name'];
export type ModePalette = Record<string, Oklch>;

/** Lighten or darken toward the far end, whichever direction increases contrast with `bg`. */
function awayFrom(bg: Oklch, color: Oklch, amount: number): Oklch {
	return shiftL(color, bg.l < 0.5 ? amount : -amount);
}

/** Solve one seed so it meets `ratio` against every background in `bgs`. */
function solveAgainst(seed: Oklch, bgs: Oklch[], ratio: number): Oklch {
	let out = seed;
	for (let pass = 0; pass < 3; pass++) {
		for (const bg of bgs) out = solveContrast(out, bg, ratio);
	}
	return out;
}

function pickOnColor(fill: Oklch, candidates: Oklch[]): Oklch {
	return candidates.reduce((best, c) => (contrast(c, fill) > contrast(best, fill) ? c : best));
}

export function deriveMode(theme: ThemeSeeds, mode: Mode): ModePalette {
	const s: ModeSeeds = theme[mode];
	const bg1 = hexToOklch(s.background);
	const bg2 = shiftL(bg1, s.inset);
	const bg3 = shiftL(bg1, s.raised);
	const bgs = [bg1, bg2, bg3];
	const ink = hexToOklch(s.foreground);

	// Text tiers: "one colour, three strengths" (spec) — ink stepped toward the background, then
	// solved so the approximation can never undercut the contrast floor.
	const fg1 = solveAgainst(ink, bgs, CONTRAST_TARGETS['fg-1']);
	const fg2 = solveAgainst(mix(bg1, fg1, 0.75), bgs, CONTRAST_TARGETS['fg-2']);
	const fg3 = solveAgainst(mix(bg1, fg1, 0.52), [bg1, bg2], CONTRAST_TARGETS['fg-3']);

	const chrome = hexToOklch(s.chrome);
	const fgOnChrome = pickOnColor(chrome, [fg1, bg1, { l: 1, c: 0, h: 0 }, { l: 0, c: 0, h: 0 }]);

	const accent = hexToOklch(theme.accent);
	const destructive = hexToOklch(theme.destructive);
	const positive = hexToOklch(theme.positive);
	const caution = hexToOklch(theme.caution);
	const accentText = (c: Oklch) => solveAgainst(c, bgs, CONTRAST_TARGETS['accent-text']);

	// Glyph on the accent fill: whichever end of the ink ladder reads best, solved to the floor.
	const onAccentSeed = pickOnColor(accent, [{ l: 1, c: 0, h: 0 }, mode === 'dark' ? bg2 : fg1]);
	const fgOnAccent = solveContrast(onAccentSeed, accent, CONTRAST_TARGETS['on-accent']);

	// Inverse = the other mode's ground and ink (the footprint hover card's deliberate flip).
	const other = theme[mode === 'dark' ? 'light' : 'dark'];
	const inverse = hexToOklch(other.background);
	const fgInverse = solveContrast(hexToOklch(other.foreground), inverse, CONTRAST_TARGETS['fg-1']);

	const focus = contrast(accent, bg1) >= CONTRAST_TARGETS.focus ? accent : fg1;

	const palette: ModePalette = {
		'bg-1': bg1,
		'bg-2': bg2,
		'bg-3': bg3,
		'bg-chrome': chrome,
		'bg-inverse': inverse,
		'fg-1': fg1,
		'fg-2': fg2,
		'fg-3': fg3,
		'fg-on-chrome': fgOnChrome,
		'fg-inverse': fgInverse,
		'fg-on-accent': fgOnAccent,
		'line-1': withAlpha(fg1, s.lines[0]),
		'line-2': withAlpha(fg1, s.lines[1]),
		'line-3': withAlpha(fg1, s.lines[2]),
		'line-strong': fg1,
		'accent-1': accent,
		'accent-1-hover': awayFrom(bg1, accent, -0.06),
		'accent-1-text': accentText(accent),
		'accent-2': destructive,
		'accent-2-hover': awayFrom(bg1, destructive, -0.06),
		'accent-2-text': accentText(destructive),
		positive,
		'positive-text': accentText(positive),
		caution,
		'caution-text': accentText(caution),
		'tint-subtle': withAlpha(fg1, s.tints.subtle),
		'tint-hover': withAlpha(fg1, s.tints.hover),
		'tint-active': withAlpha(fg1, s.tints.active),
		focus,
		overlay: hexToOklch(s.overlay),
		selection: withAlpha(accent, mode === 'dark' ? 0.35 : 0.3),
		grid: mix(bg1, fg1, mode === 'dark' ? 0.1 : 0.05)
	};

	for (const key of Object.keys(palette)) palette[key] = toGamut(palette[key]);
	return palette;
}

export interface DerivedTheme {
	id: string;
	label: string;
	light: ModePalette;
	dark: ModePalette;
}

export function deriveTheme(theme: ThemeSeeds): DerivedTheme {
	return {
		id: theme.id,
		label: theme.label,
		light: deriveMode(theme, 'light'),
		dark: deriveMode(theme, 'dark')
	};
}

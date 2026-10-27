/**
 * Theme seeds — the colour half of the system, expressed as a handful of inputs.
 *
 * SOURCE OF TRUTH. A theme is NOT a list of colours: it is ~a dozen seeds that `derive.ts` expands
 * into the full semantic ladder for BOTH light and dark mode (surfaces, text tiers, rules, accent
 * variants, tints, focus), solving text contrast against WCAG targets as it goes. Change a seed
 * here and every surface in the app re-derives consistently — run `pnpm ds:tokens` afterwards.
 *
 * The same `deriveTheme()` runs in the browser for the /designsystem theme playground, so a seed
 * tweak can be previewed live before it is committed here.
 *
 * Hex is accepted as INPUT only (designers hand over hex); everything emitted is OKLCH.
 */

export interface ModeSeeds {
	/** Background 1 — the main app surface. */
	background: string;
	/** Text 1 — full-strength ink. Text 2/3 and the rule ladder derive from it. */
	foreground: string;
	/**
	 * OKLCH lightness offsets from Background 1 for the other two tiers. The spec's elevation rule —
	 * "darker sinks, lighter floats" — holds in both modes: `inset` is negative, `raised` positive.
	 */
	inset: number;
	raised: number;
	/** Window chrome (the top bar). Spec: pure black in dark. */
	chrome: string;
	/** Rule (border) opacities for Border 1/2/3, as fractions of Text 1. */
	lines: readonly [number, number, number];
	/** Hover / active tile opacities for icon buttons (spec: 15% / 30%). */
	tints: { subtle: number; hover: number; active: number };
	/** Modal backdrop. */
	overlay: string;
}

/**
 * Structural overrides a theme may set, as `--ds-*` token names (without the prefix). Everything not
 * listed keeps the default from `scales.ts`. This is what lets a theme change *shape* — corners,
 * elevation, the voice of UI type — and not just colour.
 */
export const STRUCTURE_TOKENS = [
	'radius-sharp',
	'radius-field',
	'radius-pill',
	'radius-popup',
	'radius-card',
	'shadow-window',
	'shadow-popover',
	'border-strong',
	'ui-font',
	'ui-case',
	'tracking-label',
	'tracking-wide',
	'tracking-tight'
] as const;

export type StructureToken = (typeof STRUCTURE_TOKENS)[number];

export interface ThemeSeeds {
	id: string;
	label: string;
	description: string;
	/** Accent 1 — the one primary-action colour. Never a surface fill. */
	accent: string;
	/** Accent 2 — destructive actions only. */
	destructive: string;
	/** Status ramp (source freshness / health). */
	positive: string;
	caution: string;
	light: ModeSeeds;
	dark: ModeSeeds;
	structure?: Partial<Record<StructureToken, string>>;
	/** `partner`: inspired by a partner organisation's brand (grouped separately in the picker). */
	group?: 'alpha' | 'partner';
	/** Square mark shown on the theme card (partner themes). */
	logo?: string;
}

/**
 * Alpha — brutalist. Dark mode is the CF spec verbatim (#181818 / #121212 / #2F2F2F, white ink,
 * white rules at 10/30/50%). Light mode is the Potluck website: paper ground, white cards that
 * float, dark-blue ink, hard ink rules.
 */
export const alphaTheme: ThemeSeeds = {
	id: 'alpha',
	label: 'Alpha',
	description: 'Brutalist Potluck — sharp, flat, ink on paper, with a dark chat window.',
	accent: '#f88376',
	destructive: '#ea3729',
	positive: '#3f9e8a',
	caution: '#d4a255',
	light: {
		background: '#f7f6f6',
		foreground: '#0b252f',
		inset: -0.036,
		raised: 0.0261,
		// Chrome renders with color-scheme: dark (see build.ts), so only the dark value is visible;
		// kept equal so the token reads the same wherever it is sampled.
		chrome: '#000000',
		lines: [0.12, 0.3, 0.55],
		tints: { subtle: 0.05, hover: 0.1, active: 0.18 },
		overlay: '#0b252f99'
	},
	dark: {
		background: '#181818',
		foreground: '#ffffff',
		inset: -0.0268,
		raised: 0.0962,
		chrome: '#000000',
		lines: [0.1, 0.3, 0.5],
		tints: { subtle: 0.06, hover: 0.15, active: 0.3 },
		overlay: '#000000a6'
	}
};

/**
 * Potluck Paper — a second, deliberately different seed set. It exists to prove the engine (every
 * component must survive a theme swap with zero code changes) and to give the playground a
 * contrasting starting point. Blue-tinted neutrals, coral accent.
 */
export const paperTheme: ThemeSeeds = {
	id: 'paper',
	label: 'Potluck Paper',
	description: 'Cool blue-ink neutrals from the map site, coral accent.',
	accent: '#ff6452',
	destructive: '#c04841',
	positive: '#2f8f83',
	caution: '#c9912f',
	light: {
		background: '#f2f1f1',
		foreground: '#142e3e',
		inset: -0.028,
		raised: 0.04,
		chrome: '#142e3e',
		lines: [0.1, 0.25, 0.5],
		tints: { subtle: 0.05, hover: 0.1, active: 0.18 },
		overlay: '#142e3e80'
	},
	dark: {
		background: '#0b252f',
		foreground: '#f2f1f1',
		inset: -0.04,
		raised: 0.07,
		chrome: '#06161c',
		lines: [0.1, 0.28, 0.5],
		tints: { subtle: 0.06, hover: 0.15, active: 0.3 },
		overlay: '#000000a6'
	}
};

/**
 * Soft — the less brutalist variation. Same product, same accent family, but rounded corners, blurred
 * elevation instead of hard offsets, lighter rules, warm neutrals, and UI type in sentence-case
 * Jakarta instead of uppercase DM Mono. Exists so the brutalist direction can be compared against a
 * conventional one by switching in Settings → Appearance.
 */
export const softTheme: ThemeSeeds = {
	id: 'soft',
	label: 'Soft',
	description: 'Rounded, warm and quiet — sentence-case UI type, blurred elevation.',
	accent: '#e8735f',
	destructive: '#d93f2f',
	positive: '#2f8f6f',
	caution: '#c58a2b',
	light: {
		background: '#faf8f5',
		foreground: '#26231f',
		inset: -0.022,
		raised: 0.02,
		chrome: '#26231f',
		lines: [0.07, 0.14, 0.26],
		tints: { subtle: 0.04, hover: 0.07, active: 0.12 },
		overlay: '#26231f66'
	},
	dark: {
		background: '#1f1d1a',
		foreground: '#f4f1ec',
		inset: -0.025,
		raised: 0.055,
		chrome: '#141311',
		lines: [0.08, 0.16, 0.3],
		tints: { subtle: 0.05, hover: 0.09, active: 0.16 },
		overlay: '#00000099'
	},
	structure: {
		'radius-sharp': '8px',
		'radius-field': '16px',
		'radius-pill': '9999px',
		'radius-popup': '12px',
		'radius-card': '14px',
		'shadow-window': '0 24px 64px -24px oklch(0 0 0 / 0.35)',
		'shadow-popover': '0 12px 32px -8px oklch(0 0 0 / 0.28), 0 0 0 1px var(--ds-line-1)',
		'border-strong': '1px',
		'ui-font': 'var(--ds-font-sans)',
		'ui-case': 'none',
		'tracking-label': '0',
		'tracking-wide': '0',
		'tracking-tight': '-0.01em'
	}
};

/** Shared shape for the rounded, sentence-case themes (Soft and most partner themes). */
const roundedStructure = (radius: {
	sharp: string;
	field: string;
	popup: string;
	card: string;
}) => ({
	'radius-sharp': radius.sharp,
	'radius-field': radius.field,
	'radius-pill': '9999px',
	'radius-popup': radius.popup,
	'radius-card': radius.card,
	'shadow-window': '0 24px 64px -24px oklch(0 0 0 / 0.35)',
	'shadow-popover': '0 12px 32px -8px oklch(0 0 0 / 0.28), 0 0 0 1px var(--ds-line-1)',
	'border-strong': '1px',
	'ui-font': 'var(--ds-font-sans)',
	'ui-case': 'none',
	'tracking-label': '0',
	'tracking-wide': '0',
	'tracking-tight': '-0.01em'
});

const neutralTints = { subtle: 0.045, hover: 0.08, active: 0.14 };

/*
 * Partner themes — inspired by the organisations Alpha is built with. Brand-adjacent, not brand
 * replicas: each takes a partner's signature colour and feel, then goes through the same
 * contrast-solved derivation as every theme (tokens.spec.ts checks them all), so a bright brand
 * colour can't produce unreadable text.
 */

/** Hugging Face — the sunny yellow, warm off-white / deep navy grounds, friendly rounded shapes. */
export const huggingFaceTheme: ThemeSeeds = {
	id: 'huggingface',
	label: 'Hugging Face',
	description: 'Sunny yellow on warm neutrals, friendly rounded shapes.',
	group: 'partner',
	logo: '/logos/huggingface.png',
	accent: '#ffb000',
	destructive: '#e5484d',
	positive: '#30a46c',
	caution: '#f5a524',
	light: {
		background: '#fdfcf9',
		foreground: '#1f2328',
		inset: -0.025,
		raised: 0.02,
		chrome: '#1f2328',
		lines: [0.08, 0.15, 0.28],
		tints: neutralTints,
		overlay: '#1f232866'
	},
	dark: {
		background: '#0b0f19',
		foreground: '#f3f4f6',
		inset: -0.02,
		raised: 0.06,
		chrome: '#070a12',
		lines: [0.08, 0.16, 0.3],
		tints: { subtle: 0.05, hover: 0.09, active: 0.16 },
		overlay: '#000000a6'
	},
	structure: roundedStructure({ sharp: '10px', field: '18px', popup: '14px', card: '16px' })
};

/** Mistral — the orange sunset on cream and ink, square pixel-block shapes, mono capitals. */
export const mistralTheme: ThemeSeeds = {
	id: 'mistral',
	label: 'Mistral',
	description: 'Sunset orange on cream and ink, square and blocky, mono capitals.',
	group: 'partner',
	logo: '/logos/mistral.png',
	accent: '#fa520f',
	destructive: '#d92d20',
	positive: '#3f9e6a',
	caution: '#ffaf00',
	light: {
		background: '#fffaeb',
		foreground: '#1e1e1e',
		inset: -0.03,
		raised: 0.025,
		chrome: '#1e1e1e',
		lines: [0.1, 0.22, 0.45],
		tints: { subtle: 0.05, hover: 0.09, active: 0.16 },
		overlay: '#1e1e1e80'
	},
	dark: {
		background: '#161311',
		foreground: '#fff6e5',
		inset: -0.025,
		raised: 0.075,
		chrome: '#0c0a09',
		lines: [0.1, 0.24, 0.45],
		tints: { subtle: 0.06, hover: 0.12, active: 0.22 },
		overlay: '#000000a6'
	},
	structure: {
		'radius-sharp': '0px',
		'radius-field': '0px',
		'radius-popup': '0px',
		'shadow-popover': '0 0 0 1px var(--ds-line-2), 0 10px 24px -12px oklch(0 0 0 / 0.35)'
	}
};

/** Infomaniak — Swiss sky blue on crisp light grey / midnight, clean and gently rounded. */
export const infomaniakTheme: ThemeSeeds = {
	id: 'infomaniak',
	label: 'Infomaniak',
	description: 'Swiss sky blue, crisp and clean, gently rounded.',
	group: 'partner',
	logo: '/logos/infomaniak.png',
	accent: '#0098ff',
	destructive: '#e5484d',
	positive: '#1f9d6a',
	caution: '#e8a317',
	light: {
		background: '#f5f7fa',
		foreground: '#1a2033',
		inset: -0.025,
		raised: 0.03,
		chrome: '#1a2033',
		lines: [0.08, 0.16, 0.3],
		tints: neutralTints,
		overlay: '#1a203366'
	},
	dark: {
		background: '#12151f',
		foreground: '#eef2f8',
		inset: -0.02,
		raised: 0.06,
		chrome: '#0a0c13',
		lines: [0.08, 0.16, 0.3],
		tints: { subtle: 0.05, hover: 0.09, active: 0.16 },
		overlay: '#000000a6'
	},
	structure: roundedStructure({ sharp: '8px', field: '14px', popup: '12px', card: '12px' })
};

/** Cohere — coral on deep forest green and cream, soft and generous. */
export const cohereTheme: ThemeSeeds = {
	id: 'cohere',
	label: 'Cohere',
	description: 'Coral on forest green and cream, soft and generous.',
	group: 'partner',
	logo: '/logos/cohere.png',
	accent: '#ff7759',
	destructive: '#d8452f',
	positive: '#4c8a6f',
	caution: '#d99a2b',
	light: {
		background: '#f7f5ef',
		foreground: '#17271f',
		inset: -0.025,
		raised: 0.025,
		chrome: '#17271f',
		lines: [0.08, 0.16, 0.3],
		tints: neutralTints,
		overlay: '#17271f66'
	},
	dark: {
		background: '#10201a',
		foreground: '#f1efe7',
		inset: -0.025,
		raised: 0.06,
		chrome: '#08120e',
		lines: [0.08, 0.17, 0.32],
		tints: { subtle: 0.05, hover: 0.1, active: 0.18 },
		overlay: '#000000a6'
	},
	structure: roundedStructure({ sharp: '12px', field: '22px', popup: '16px', card: '20px' })
};

/** Swiss AI Initiative — Swiss red on white and charcoal, precise, lightly rounded. */
export const swissAiTheme: ThemeSeeds = {
	id: 'swiss-ai',
	label: 'Swiss AI',
	description: 'Swiss red on white and charcoal, precise and lightly rounded.',
	group: 'partner',
	logo: '/logos/swiss-ai.png',
	accent: '#e4002b',
	destructive: '#b3261e',
	positive: '#2e8b57',
	caution: '#d4a017',
	light: {
		background: '#f8f8f8',
		foreground: '#1c1c1e',
		inset: -0.03,
		raised: 0.02,
		chrome: '#1c1c1e',
		lines: [0.09, 0.18, 0.35],
		tints: neutralTints,
		overlay: '#1c1c1e66'
	},
	dark: {
		background: '#1a1a1c',
		foreground: '#fafafa',
		inset: -0.025,
		raised: 0.065,
		chrome: '#0e0e10',
		lines: [0.09, 0.2, 0.36],
		tints: { subtle: 0.05, hover: 0.1, active: 0.18 },
		overlay: '#000000a6'
	},
	structure: roundedStructure({ sharp: '4px', field: '10px', popup: '8px', card: '8px' })
};

export const themes = [
	alphaTheme,
	softTheme,
	paperTheme,
	huggingFaceTheme,
	mistralTheme,
	infomaniakTheme,
	cohereTheme,
	swissAiTheme
] as const;

/** Accent presets offered by the custom-theme builder (Settings → Appearance → Advanced). */
export const accentPresets = [
	'#f88376',
	'#e8735f',
	'#f2b33d',
	'#3f9e8a',
	'#4f8fe6',
	'#8f6cf0',
	'#e05fa8'
] as const;
export type ThemeId = (typeof themes)[number]['id'];
export const defaultThemeId: ThemeId = 'alpha';

export function getTheme(id: string): ThemeSeeds {
	return themes.find((t) => t.id === id) ?? alphaTheme;
}

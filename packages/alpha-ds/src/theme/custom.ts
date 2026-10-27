/**
 * Custom themes — a person's own theme, built from a handful of plain choices on top of one of the
 * shipped themes. Derived with the SAME pipeline as the shipped ones (`deriveTheme` → contrast-solved
 * ladder), so a custom theme can change colour and shape but can't produce unreadable text.
 *
 * Applied at runtime as inline `--ds-*` overrides on the ThemeProvider (and its portal host), with
 * `data-ds-theme` set to the base theme so anything not chosen falls back to it.
 */
import { themeDeclarations } from '../tokens/build.ts';
import { getTheme, type ThemeSeeds } from '../tokens/themes.ts';

export const CUSTOM_THEME_ID = 'custom';

export type CustomCorners = 'sharp' | 'rounded' | 'round';
export type CustomElevation = 'flat' | 'soft';
export type CustomUiType = 'mono' | 'sans';

export interface CustomThemeInput {
	/** Shipped theme to start from. */
	base: string;
	accent: string;
	/** Ground colours — the derivation builds every surface, line and text tier from these. */
	darkBackground: string;
	lightBackground: string;
	corners: CustomCorners;
	elevation: CustomElevation;
	uiType: CustomUiType;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function defaultCustomTheme(base = 'alpha'): CustomThemeInput {
	const seeds = getTheme(base);
	return {
		base: seeds.id,
		accent: seeds.accent,
		darkBackground: seeds.dark.background,
		lightBackground: seeds.light.background,
		corners: (seeds.structure?.['radius-sharp'] ?? '4px') === '0px' ? 'sharp' : 'rounded',
		elevation: seeds.structure?.['shadow-popover'] ? 'soft' : 'flat',
		uiType: seeds.structure?.['ui-font'] ? 'sans' : 'mono'
	};
}

/** Parse untrusted stored JSON; anything malformed yields undefined rather than a half theme. */
export function parseCustomTheme(raw: string | null | undefined): CustomThemeInput | undefined {
	if (!raw) return undefined;
	try {
		const v = JSON.parse(raw) as Partial<CustomThemeInput>;
		const ok =
			typeof v.base === 'string' &&
			HEX.test(v.accent ?? '') &&
			HEX.test(v.darkBackground ?? '') &&
			HEX.test(v.lightBackground ?? '') &&
			['sharp', 'rounded', 'round'].includes(v.corners ?? '') &&
			['flat', 'soft'].includes(v.elevation ?? '') &&
			['mono', 'sans'].includes(v.uiType ?? '');
		return ok ? (v as CustomThemeInput) : undefined;
	} catch {
		return undefined;
	}
}

const CORNERS: Record<CustomCorners, [sharp: string, field: string, popup: string, card: string]> =
	{
		sharp: ['0px', '10px', '0px', '0px'], // truly square — the original brutalist look
		rounded: ['8px', '16px', '12px', '14px'],
		round: ['14px', '24px', '18px', '20px']
	};

export function customThemeSeeds(input: CustomThemeInput): ThemeSeeds {
	const base = getTheme(input.base);
	const [sharp, field, popup, card] = CORNERS[input.corners];
	return {
		...base,
		id: CUSTOM_THEME_ID,
		label: 'Custom',
		description: `Your theme, based on ${base.label}.`,
		accent: input.accent,
		light: { ...base.light, background: input.lightBackground },
		dark: { ...base.dark, background: input.darkBackground },
		structure: {
			...base.structure,
			'radius-sharp': sharp,
			'radius-field': field,
			'radius-popup': popup,
			'radius-card': card,
			...(input.elevation === 'soft'
				? {
						'shadow-window': '0 24px 64px -24px oklch(0 0 0 / 0.35)',
						'shadow-popover': '0 12px 32px -8px oklch(0 0 0 / 0.28), 0 0 0 1px var(--ds-line-1)',
						'border-strong': '1px'
					}
				: {
						'shadow-popover': '0 0 0 1px var(--ds-line-1), 0 2px 4px -1px oklch(0 0 0 / 0.12)',
						'border-strong': '2px'
					}),
			...(input.uiType === 'sans'
				? {
						'ui-font': 'var(--ds-font-sans)',
						'ui-case': 'none',
						'tracking-label': '0',
						'tracking-wide': '0'
					}
				: {
						'ui-font': 'var(--ds-font-mono)',
						'ui-case': 'uppercase',
						'tracking-label': '0.05em',
						'tracking-wide': '0.08em'
					})
		}
	};
}

/** Every `--ds-*` declaration the custom theme sets — colours plus structure. */
export function customThemeDeclarations(input: CustomThemeInput): Record<string, string> {
	const seeds = customThemeSeeds(input);
	const structure = Object.fromEntries(
		Object.entries(seeds.structure ?? {}).map(([k, v]) => [`--ds-${k}`, v as string])
	);
	return { ...themeDeclarations(seeds), ...structure };
}

import { getContext, setContext } from 'svelte';
import type { ColorMode, ResolvedMode } from './mode.svelte.ts';
import type { CustomThemeInput } from './custom.ts';

export interface ThemeContext {
	readonly theme: string;
	readonly mode: ColorMode;
	readonly resolvedMode: ResolvedMode;
	/**
	 * Where floating parts (Dialog, Popover, Menu, Tooltip, Select, Toast) portal to. A body-level
	 * element carrying the same theme, mode and overrides as the provider — so a popup escapes the
	 * window's overflow clipping without falling out of the design system.
	 */
	readonly portalTarget: HTMLElement | undefined;
	setMode(mode: ColorMode): void;
	/** Switch the seed set (a `tokens/themes.ts` id). Persisted when the provider has `persistTheme`. */
	setTheme(theme: string): void;
	/** The person's custom theme, if they have built one. */
	readonly custom: CustomThemeInput | undefined;
	/** Save a custom theme and switch to it (`theme` becomes `custom`). */
	setCustom(input: CustomThemeInput): void;
	/** Preview a theme on the whole window without saving (null ends the preview). */
	preview(theme: string | null): void;
	/** Preview an unsaved custom theme on the whole window (null ends the preview). */
	previewCustom(input: CustomThemeInput | null): void;
}

const KEY = Symbol('alpha-ds.theme');

export function setThemeContext(ctx: ThemeContext): void {
	setContext(KEY, ctx);
}

/** The nearest ThemeProvider, or undefined outside one (parts then portal to <body>). */
export function getThemeContext(): ThemeContext | undefined {
	return getContext<ThemeContext | undefined>(KEY);
}

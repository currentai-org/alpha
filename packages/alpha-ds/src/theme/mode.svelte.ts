/**
 * Colour-mode state: `light | dark | system`.
 *
 * Rendering does not depend on this — `light-dark()` tokens follow `color-scheme`, which the
 * provider sets from `data-mode` (or leaves to the OS for "system"). This class exists for the
 * two things CSS cannot do: persist the user's choice, and expose the RESOLVED mode to legacy
 * markup that still keys off a `.dark` class (Tailwind `dark:` variants in the chat code).
 */
import { browser } from '$app/environment';
import { on } from 'svelte/events';

export type ColorMode = 'light' | 'dark' | 'system';
export type ResolvedMode = 'light' | 'dark';

export const COLOR_MODES: readonly ColorMode[] = ['light', 'dark', 'system'];

const isMode = (v: unknown): v is ColorMode => v === 'light' || v === 'dark' || v === 'system';

export function readStoredMode(key: string | undefined): ColorMode | undefined {
	if (!browser || !key) return undefined;
	try {
		const v = localStorage.getItem(key);
		return isMode(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredMode(key: string | undefined, mode: ColorMode): void {
	if (!browser || !key) return;
	try {
		localStorage.setItem(key, mode);
	} catch {
		// Private mode / storage disabled — the choice simply doesn't persist.
	}
}

const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function readStoredTheme(key: string | undefined): string | undefined {
	if (!browser || !key) return undefined;
	try {
		const v = localStorage.getItem(key);
		return v && THEME_ID.test(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

export function writeStoredTheme(key: string | undefined, theme: string): void {
	if (!browser || !key) return;
	try {
		localStorage.setItem(key, theme);
	} catch {
		// Storage disabled — the choice simply doesn't persist.
	}
}

/** Tracks the OS preference; one listener per instance, torn down with the owning effect. */
export class SystemPreference {
	dark = $state(false);

	constructor() {
		if (!browser) return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		this.dark = mq.matches;
		$effect(() => on(mq, 'change', (e) => (this.dark = (e as MediaQueryListEvent).matches)));
	}
}

export function resolveMode(mode: ColorMode, systemDark: boolean): ResolvedMode {
	if (mode === 'system') return systemDark ? 'dark' : 'light';
	return mode;
}

/**
 * Inline, render-blocking script that applies a persisted mode and theme to its parent element
 * before first paint, so a stored choice never flashes the default on a server-rendered page.
 */
export function noFlashScript(modeKey?: string, themeKey?: string): string {
	const mk = JSON.stringify(modeKey ?? '');
	const tk = JSON.stringify(themeKey ?? '');
	return (
		`<script>(function(){try{var e=document.currentScript&&document.currentScript.parentElement;if(!e)return;` +
		`var m=${mk}&&localStorage.getItem(${mk});if(m==='light'||m==='dark'||m==='system'){e.dataset.mode=m;` +
		`var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);e.classList.toggle('dark',d);}` +
		`var t=${tk}&&localStorage.getItem(${tk});if(t&&/^[a-z][a-z0-9-]{0,31}$/.test(t)){e.dataset.dsTheme=t;}}catch(_){}})()<` +
		`/script>`
	);
}

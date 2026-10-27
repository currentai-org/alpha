<!--
  @component
  Opts a subtree into the Alpha design system.

  Sets `.ds-root` (base styles + legacy bridge), `data-ds-theme` (which seed set), `data-mode`
  (light | dark | system → `color-scheme`, which every `light-dark()` token follows) and
  `data-surface` (the surface context). Also owns a body-level portal host that mirrors all of
  that, so floating parts stay themed after they leave the subtree.

  ```svelte
  <ThemeProvider mode="dark" persist="alpha:mode">…</ThemeProvider>
  ```
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { browser } from '$app/environment';
	import { Tooltip } from 'bits-ui';
	import { cn } from '../internal/cn.ts';
	import type { SurfaceLevel } from '../internal/types.ts';
	import { defaultThemeId } from '../tokens/themes.ts';
	import { setThemeContext } from './context.ts';
	import {
		type ColorMode,
		noFlashScript,
		readStoredMode,
		readStoredTheme,
		resolveMode,
		SystemPreference,
		writeStoredMode,
		writeStoredTheme
	} from './mode.svelte.ts';
	import {
		CUSTOM_THEME_ID,
		customThemeDeclarations,
		parseCustomTheme,
		type CustomThemeInput
	} from './custom.ts';

	interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'style'> {
		/** Seed set id from `tokens/themes.ts`. Bindable. */
		theme?: string;
		/** localStorage key to persist the theme under (and restore before first paint). */
		persistTheme?: string;
		/** Colour mode. Bindable; `system` follows the OS live. */
		mode?: ColorMode;
		/** localStorage key to persist the mode under (and restore before first paint). */
		persist?: string;
		/** Surface tier this subtree starts on. */
		surface?: SurfaceLevel;
		/** localStorage key for a custom theme (`theme="custom"`), built in Settings → Appearance. */
		persistCustom?: string;
		/** Runtime `--ds-*` overrides (theme playground). Values are applied inline. */
		overrides?: Record<string, string>;
		/** Render as `display: contents` — theme a subtree without adding a layout box. */
		contents?: boolean;
		children?: Snippet;
	}

	let {
		theme = $bindable(defaultThemeId),
		persistTheme,
		mode = $bindable('system'),
		persist,
		persistCustom,
		surface = '1',
		overrides,
		contents = false,
		class: className,
		children,
		...rest
	}: Props = $props();

	// Restore a persisted choice synchronously so the first client render already agrees with the
	// DOM the no-flash script produced.
	if (browser && persist) {
		const stored = readStoredMode(persist);
		if (stored) mode = stored;
	}
	if (browser && persistTheme) {
		const stored = readStoredTheme(persistTheme);
		if (stored) theme = stored;
	}

	// A custom theme is the base theme's id on the DOM plus inline overrides for what was chosen.
	// Read once at mount, like the persisted mode/theme above.
	let custom = $state<CustomThemeInput | undefined>(
		untrack(() =>
			browser && persistCustom ? parseCustomTheme(localStorage.getItem(persistCustom)) : undefined
		)
	);
	$effect(() => {
		if (!browser || !persistCustom) return;
		try {
			if (custom) localStorage.setItem(persistCustom, JSON.stringify(custom));
		} catch {
			/* storage unavailable */
		}
	});
	// Live preview (hovering a theme, editing a custom one): shown on the whole window, never
	// persisted. `previewInput` previews an unsaved custom theme; `previewId` any theme by id.
	let previewId = $state<string | null>(null);
	let previewInput = $state<CustomThemeInput | null>(null);
	const shownTheme = $derived(previewInput ? CUSTOM_THEME_ID : (previewId ?? theme));
	const shownCustom = $derived(previewInput ?? custom);

	const usingCustom = $derived(shownTheme === CUSTOM_THEME_ID && !!shownCustom);
	const domTheme = $derived(usingCustom && shownCustom ? shownCustom.base : shownTheme);
	const allOverrides = $derived(
		usingCustom && shownCustom
			? { ...customThemeDeclarations(shownCustom), ...overrides }
			: overrides
	);

	const system = new SystemPreference();
	const resolvedMode = $derived(resolveMode(mode, system.dark));

	$effect(() => writeStoredMode(persist, mode));
	$effect(() => writeStoredTheme(persistTheme, theme));

	const style = $derived(
		allOverrides
			? Object.entries(allOverrides)
					.map(([k, v]) => `${k}: ${v}`)
					.join('; ')
			: undefined
	);

	let portalHost = $state<HTMLElement>();

	$effect(() => {
		const host = document.createElement('div');
		host.setAttribute('data-ds-portal', '');
		document.body.appendChild(host);
		portalHost = host;
		return () => {
			host.remove();
			portalHost = undefined;
		};
	});

	$effect(() => {
		if (!portalHost) return;
		portalHost.className = cn('ds-root ds-portal-host', resolvedMode === 'dark' && 'dark');
		portalHost.dataset.dsTheme = domTheme;
		portalHost.dataset.mode = mode;
		portalHost.setAttribute('style', `background: transparent; ${style ?? ''}`);
	});

	setThemeContext({
		get theme() {
			return theme;
		},
		get mode() {
			return mode;
		},
		get resolvedMode() {
			return resolvedMode;
		},
		get portalTarget() {
			return portalHost;
		},
		setMode(next) {
			mode = next;
		},
		setTheme(next) {
			previewId = null;
			previewInput = null;
			theme = next;
		},
		preview(next) {
			previewInput = null;
			previewId = next;
		},
		previewCustom(input) {
			previewId = null;
			previewInput = input;
		},
		get custom() {
			return custom;
		},
		setCustom(next) {
			previewId = null;
			previewInput = null;
			custom = next;
			theme = CUSTOM_THEME_ID;
		}
	});
</script>

<div
	{...rest}
	class={cn('ds-root', resolvedMode === 'dark' && 'dark', contents && 'contents', className)}
	data-ds-theme={domTheme}
	data-ds-custom={usingCustom ? '' : undefined}
	data-mode={mode}
	data-surface={surface}
	{style}
>
	{#if persist || persistTheme}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -- static script, keys are JSON-escaped -->
		{@html noFlashScript(persist, persistTheme)}
	{/if}
	<Tooltip.Provider delayDuration={500} skipDelayDuration={300}>
		{@render children?.()}
	</Tooltip.Provider>
</div>

<style>
	:global(.ds-portal-host) {
		position: relative;
		z-index: var(--ds-z-popover);
	}
</style>

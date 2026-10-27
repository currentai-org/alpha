<!--
  @component
  The /designsystem frame: sticky header (brand, search, theme, mode), grouped nav, content.
  Built from the design system itself — the docs are its first consumer.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import RiMenuLine from '~icons/ri/menu-line';
	import RiSearchLine from '~icons/ri/search-line';
	import {
		Button,
		Kbd,
		Select,
		ThemeProvider,
		Toggle,
		ToggleGroup,
		type ColorMode
	} from '@aipotluck/alpha-ds';
	import { themes } from '../../tokens/themes.ts';
	import DocsNav from './DocsNav.svelte';
	import SearchDialog from './SearchDialog.svelte';

	let { version, children }: { version?: string; children?: Snippet } = $props();

	let mode = $state<ColorMode>('dark');
	let theme = $state('alpha');
	let searchOpen = $state(false);
	let navOpen = $state(false);
	const themeItems = themes.map((t) => ({ value: t.id, label: t.label }));
</script>

<ThemeProvider bind:mode {theme} persist="alpha-ds:docs-mode" class="min-h-dvh pt-site-header">
	<header
		data-surface="1"
		class="sticky top-site-header z-header flex h-header items-center gap-3 border-b border-line-2 bg-surface-1 px-4"
	>
		<Button
			variant="ghost"
			size="icon"
			class="lg:hidden"
			aria-label="Open navigation"
			onclick={() => (navOpen = !navOpen)}
		>
			<RiMenuLine />
		</Button>
		<a href={resolve('/designsystem')} class="flex items-center gap-2 no-underline">
			<span class="block size-2.5 rotate-45 bg-accent-1" aria-hidden="true"></span>
			<span class="type-label text-fg-1">Alpha</span>
			<span class="type-label text-fg-3 max-sm:hidden">/ Design system</span>
		</a>
		{#if version}
			<a
				href={resolve('/designsystem/[slug]', { slug: 'changelog' })}
				title="Changelog — the version is derived from it"
				class="flex h-5 items-center border border-line-surface px-1.5 font-mono text-micro text-fg-2 no-underline transition-control hover:text-fg-1"
				>v{version}</a
			>
		{/if}
		<div class="flex-1"></div>
		<Button
			size="sm"
			class="w-56 justify-between max-sm:hidden"
			onclick={() => (searchOpen = true)}
		>
			<span class="flex items-center gap-2 normal-case"><RiSearchLine /> Search</span>
			<Kbd mod>K</Kbd>
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="sm:hidden"
			aria-label="Search"
			onclick={() => (searchOpen = true)}><RiSearchLine /></Button
		>
		<Select.Root bind:value={theme} items={themeItems}>
			<Select.Trigger size="sm" class="w-40 max-md:hidden" aria-label="Theme"
				><Select.Value /><Select.Icon /></Select.Trigger
			>
			<Select.Portal>
				<Select.Positioner>
					<Select.Popup>
						{#each themeItems as t (t.value)}<Select.Item value={t.value} label={t.label}
								>{t.label}</Select.Item
							>{/each}
					</Select.Popup>
				</Select.Positioner>
			</Select.Portal>
		</Select.Root>
		<ToggleGroup
			bind:value={() => [mode], (v: string[]) => (mode = (v[0] as ColorMode) ?? mode)}
			aria-label="Colour mode"
		>
			<Toggle value="light">Light</Toggle>
			<Toggle value="dark">Dark</Toggle>
			<Toggle value="system" class="max-sm:hidden">Auto</Toggle>
		</ToggleGroup>
	</header>

	<div class="mx-auto flex w-full max-w-8xl">
		<aside
			data-surface="1"
			data-open={navOpen ? '' : undefined}
			class="ds-docs-nav fixed inset-y-0 left-0 z-overlay flex w-64 shrink-0 -translate-x-full flex-col border-r border-line-2 bg-surface-1 pt-site-header transition-transform lg:z-auto lg:translate-x-0 lg:pt-0 data-open:translate-x-0"
		>
			<DocsNav onnavigate={() => (navOpen = false)} />
		</aside>
		{#if navOpen}
			<button
				type="button"
				class="fixed inset-0 z-sticky bg-overlay lg:hidden"
				aria-label="Close navigation"
				onclick={() => (navOpen = false)}
			></button>
		{/if}
		<main class="min-w-0 flex-1">{@render children?.()}</main>
	</div>
	<SearchDialog bind:open={searchOpen} />
</ThemeProvider>

<style>
	/* Sticky under the site header + docs header; the one calc on the page. */
	@media (min-width: 64rem) {
		.ds-docs-nav {
			position: sticky;
			top: calc(var(--nav-bar-offset) + var(--ds-header-height));
			height: calc(100dvh - var(--nav-bar-offset) - var(--ds-header-height));
		}
	}
</style>

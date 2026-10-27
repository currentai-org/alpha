<!--
  @component
  `Sidebar.Header` — top row: the brand (children) on the left, the collapse ("pin") toggle on the
  right edge, revealed on hover or keyboard focus. In the collapsed rail, `mark` (e.g. the app logo)
  sits at the top and hovering the sidebar swaps it for the toggle. Under `md` the toggle is the
  drawer's close button, always visible.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import RiSideBarLine from '~icons/ri/side-bar-line';
	import RiCloseLine from '~icons/ri/close-line';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import { getAppShell } from '../app-shell/context.svelte.ts';

	let {
		expandLabel = 'Expand sidebar',
		collapseLabel = 'Collapse sidebar',
		closeLabel = 'Close sidebar',
		class: className,
		children,
		mark
	}: {
		/** Accessible labels supplied by the application for its interface locale. */
		expandLabel?: string;
		collapseLabel?: string;
		closeLabel?: string;
		class?: string;
		children?: Snippet;
		/** Shown alone in the collapsed rail (the app logo); hover reveals the toggle in its place. */
		mark?: Snippet;
	} = $props();
	const shell = getAppShell();
</script>

<div
	class={cn(
		'flex h-header shrink-0 items-center gap-2 px-2 max-md:h-14 md:group-data-collapsed/sidebar:justify-center',
		className
	)}
>
	{#if children}
		<div class="flex min-w-0 flex-1 items-center gap-2 md:group-data-collapsed/sidebar:hidden">
			{@render children()}
		</div>
	{/if}
	{#if mark}
		<!-- Rail only: the logo, until the sidebar is hovered or focused. -->
		<div
			class="hidden size-control-md items-center justify-center md:group-data-collapsed/sidebar:flex md:group-data-collapsed/sidebar:group-focus-within/sidebar:hidden md:group-data-collapsed/sidebar:group-hover/sidebar:hidden"
		>
			{@render mark()}
		</div>
	{/if}
	<button
		type="button"
		class={cn(
			buttonRecipe({ variant: 'ghost', size: 'icon' }),
			'ml-auto hidden md:inline-flex',
			// Expanded: tucked away until you're in the sidebar.
			'md:opacity-0 md:group-focus-within/sidebar:opacity-100 md:group-hover/sidebar:opacity-100 md:focus-visible:opacity-100',
			// Rail: replaces the logo on hover/focus (and is the only thing there when there's no logo).
			'md:group-data-collapsed/sidebar:ml-0 md:group-data-collapsed/sidebar:opacity-100',
			mark &&
				'md:group-data-collapsed/sidebar:hidden md:group-data-collapsed/sidebar:group-focus-within/sidebar:inline-flex md:group-data-collapsed/sidebar:group-hover/sidebar:inline-flex'
		)}
		aria-label={shell.collapsed ? expandLabel : collapseLabel}
		aria-expanded={!shell.collapsed}
		onclick={() => shell.toggleSidebar()}
	>
		<RiSideBarLine aria-hidden="true" />
	</button>
	<button
		type="button"
		class={cn(buttonRecipe({ variant: 'ghost', size: 'icon-lg' }), 'ml-auto md:hidden')}
		aria-label={closeLabel}
		onclick={() => shell.setMobileOpen(false)}
	>
		<RiCloseLine aria-hidden="true" />
	</button>
</div>

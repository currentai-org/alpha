<!--
  @component
  `ThreadHeader` — the conversation's top bar (title centre-left, actions right).
  On mobile a leading menu button opens the sidebar drawer. Hairline Border 1 underneath: the
  header belongs to the thread, it is not chrome.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import RiMenuLine from '~icons/ri/menu-line';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe } from '../../components/button/button.recipe.ts';
	import { getAppShell } from '../app-shell/context.svelte.ts';

	let {
		openSidebarLabel = 'Open sidebar',
		title,
		leading,
		actions,
		class: className
	}: {
		/** Accessible sidebar trigger label supplied by the application. */
		openSidebarLabel?: string;
		/** Conversation title — text, or a snippet (e.g. an inline rename field). */
		title?: string | Snippet;
		/** Left of the title (breadcrumb, model badge). */
		leading?: Snippet;
		/** Right-aligned actions (share, more). */
		actions?: Snippet;
		class?: string;
	} = $props();
	const shell = getAppShell();
</script>

<header
	class={cn(
		'sticky top-0 z-header flex h-header shrink-0 items-center gap-2 border-b border-line-1 bg-surface-1 px-3',
		className
	)}
>
	<button
		type="button"
		class={cn(buttonRecipe({ variant: 'ghost', size: 'icon' }), 'md:hidden')}
		aria-label={openSidebarLabel}
		data-sidebar-open
		aria-expanded={shell.mobileOpen}
		onclick={() => shell.setMobileOpen(true)}
	>
		<RiMenuLine aria-hidden="true" />
	</button>
	{@render leading?.()}
	<div class="flex min-w-0 flex-1 items-center">
		{#if typeof title === 'string'}
			<h1 class="truncate type-body font-medium text-fg-1">{title}</h1>
		{:else if title}
			{@render title()}
		{/if}
	</div>
	{#if actions}<div class="flex shrink-0 items-center gap-1">{@render actions()}</div>{/if}
</header>

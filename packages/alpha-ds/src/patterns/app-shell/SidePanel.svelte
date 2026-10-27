<!--
  @component
  `AppShell.SidePanel` — the right-hand floating panel (XRAY view, artifacts). Background 3: the
  spec's surface for "anything that floats above the main content". Full-screen sheet on mobile.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { getAppShell } from './context.svelte.ts';

	let {
		label = 'Details',
		class: className,
		children
	}: { label?: string; class?: string; children?: Snippet } = $props();
	const shell = getAppShell();
</script>

{#if shell.sidePanelOpen}
	<aside
		aria-label={label}
		data-surface="3"
		data-state="open"
		class={cn(
			'fixed inset-0 z-overlay flex min-h-0 motion-fade flex-col bg-surface-3 text-fg-1',
			'md:relative md:inset-auto md:z-auto md:w-side-panel md:shrink-0 md:border-l md:border-line-3',
			className
		)}
	>
		{@render children?.()}
	</aside>
{/if}

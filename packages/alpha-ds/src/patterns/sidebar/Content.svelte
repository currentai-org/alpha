<!--
  @component
  `Sidebar.Content` — the scrolling middle (recents, projects). Hidden in the collapsed rail.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<nav
	class={cn(
		'flex min-h-0 flex-1 scroll-fade-y flex-col gap-4 overflow-y-auto overscroll-contain px-2 pb-4 group-data-collapsed/sidebar:md:invisible',
		className
	)}
>
	{@render children?.()}
</nav>

<!--
  @component
  `AppShell.Main` — the conversation column. Put a `ThreadHeader` first, then a scroll region.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	import { getAppShell } from './context.svelte.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
	const shell = getAppShell();
</script>

<!-- Mobile drawer open: slide right by the sidebar's width and fade back, so the sidebar reads as
     pushing the conversation aside (native app shape) rather than covering it. -->
<main
	data-surface="1"
	data-pushed={shell.mobileOpen ? '' : undefined}
	class={cn(
		'relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface-1',
		'transition-[translate,opacity] duration-(--ds-duration-base) ease-standard',
		'max-md:data-pushed:pointer-events-none max-md:data-pushed:translate-x-sidebar max-md:data-pushed:opacity-50',
		className
	)}
>
	{@render children?.()}
</main>

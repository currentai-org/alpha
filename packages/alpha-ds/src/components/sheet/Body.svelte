<!--
  @component
  `Sheet.Body` — the sheet's scrolling content, with the scroll shadow at both edges.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div
	class={cn(
		'scrollbar-custom flex min-h-0 flex-1 scroll-fade-y flex-col gap-4 overflow-y-auto overscroll-contain p-4',
		className
	)}
>
	{@render children?.()}
</div>

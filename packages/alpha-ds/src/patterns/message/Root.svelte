<!--
  @component
  `Message.Root` — one turn. Chat-app layout: the user's turn is a right-aligned bubble
  (Background 2, Border 1 — the spec's "outline on chat reply/message boxes"); the assistant's
  turn is full-width text with no box.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		from,
		class: className,
		children
	}: { from: 'user' | 'assistant'; class?: string; children?: Snippet } = $props();
</script>

<article
	data-from={from}
	class={cn(
		'group/message flex w-full flex-col gap-2',
		from === 'user' ? 'items-end' : 'items-start',
		className
	)}
>
	{@render children?.()}
</article>

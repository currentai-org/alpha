<!--
  @component
  `Message.Actions` — the icon row under a turn (copy, retry, report). Quiet until hovered on
  desktop; always visible on touch.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div
	class={cn(
		'flex items-center gap-0.5 text-fg-3 transition-opacity focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100',
		className
	)}
>
	{@render children?.()}
</div>

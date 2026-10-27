<!--
  @component
  Base UI `ScrollArea.Content` — the scrolled content box inside the viewport.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('min-w-full', className)}>{@render children?.()}</div>

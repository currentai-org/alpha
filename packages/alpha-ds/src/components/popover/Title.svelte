<!--
  @component
  Base UI `Popover.Title` — heading inside a popover.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<h2 class={cn('type-title text-fg-1', className)}>{@render children?.()}</h2>

<!--
  @component
  Base UI `Popover.Description`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<p class={cn('mt-1 type-caption text-fg-2', className)}>{@render children?.()}</p>

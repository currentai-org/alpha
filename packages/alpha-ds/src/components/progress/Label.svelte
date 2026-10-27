<!--
  @component
  Base UI `Progress.Label`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { getRange } from './context.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
	const range = getRange();
</script>

<span id={range.labelId} class={cn('type-label text-fg-2', className)}>{@render children?.()}</span>

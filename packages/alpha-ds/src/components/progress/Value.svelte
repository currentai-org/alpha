<!--
  @component
  Base UI `Progress.Value` — the formatted value (DM Mono, tabular).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { getRange } from './context.ts';

	let {
		class: className,
		children
	}: { class?: string; children?: Snippet<[string, number | null]> } = $props();
	const range = getRange();
</script>

<span class={cn('justify-self-end type-code text-fg-1 tabular-nums', className)}>
	{#if children}{@render children(range.formatted, range.value)}{:else}{range.formatted}{/if}
</span>

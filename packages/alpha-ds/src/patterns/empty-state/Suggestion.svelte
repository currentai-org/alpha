<!--
  @component
  `EmptyState.Suggestion` — a prompt-example button (spec: Radius 2, Font 1 Size 2, Text 3 →
  Text 1 on hover; rest fill one tier up).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		onclick,
		disabled = false,
		class: className,
		children
	}: { onclick?: () => void; disabled?: boolean; class?: string; children?: Snippet } = $props();
</script>

<button
	type="button"
	{onclick}
	{disabled}
	class={cn(
		'rounded-field border border-line-1 bg-surface-raised px-3 py-2 text-left type-caption text-fg-3 transition-control',
		'hover:tint-hover hover:text-fg-1 disabled:cursor-wait disabled:opacity-60',
		className
	)}
>
	{@render children?.()}
</button>

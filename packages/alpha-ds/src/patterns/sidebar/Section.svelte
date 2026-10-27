<!--
  @component
  `Sidebar.Section` — a labelled group of items ("Today", "Last 7 days", "Projects").
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		label,
		action,
		class: className,
		children
	}: { label?: string; action?: Snippet; class?: string; children?: Snippet } = $props();
	const uid = $props.id();
</script>

<section
	class={cn('flex flex-col', className)}
	aria-labelledby={label ? `${uid}-label` : undefined}
>
	{#if label}
		<div class="flex h-control-sm items-center justify-between px-2">
			<h3 id="{uid}-label" class="type-label text-fg-3">{label}</h3>
			{@render action?.()}
		</div>
	{/if}
	<ul class="flex flex-col gap-px" role="list">{@render children?.()}</ul>
</section>

<!--
  @component
  `Composer.Tools` — left-aligned tool controls (attach, toggle pills, model picker).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('flex min-w-0 flex-1 flex-wrap items-center gap-1.5', className)}>
	{@render children?.()}
</div>

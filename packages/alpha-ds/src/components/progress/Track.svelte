<!--
  @component
  Base UI `Progress.Track`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('relative col-span-2 h-1.5 overflow-hidden bg-line-1', className)}>
	{@render children?.()}
</div>

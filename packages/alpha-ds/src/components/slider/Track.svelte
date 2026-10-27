<!--
  @component
  Base UI `Slider.Track`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('relative h-1 w-full grow bg-line-2', className)}>{@render children?.()}</div>

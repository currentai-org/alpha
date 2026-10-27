<!--
  @component
  Base UI `Slider.Control` — the interactive hit area around the track.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('relative flex h-5 w-full items-center', className)}>{@render children?.()}</div>

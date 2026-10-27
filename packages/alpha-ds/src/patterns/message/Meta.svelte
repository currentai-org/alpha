<!--
  @component
  `Message.Meta` — provenance line (model, where it ran, time). DM Mono micro, Text 3.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('flex flex-wrap items-center gap-x-2 gap-y-1 type-label text-fg-3', className)}>
	{@render children?.()}
</div>

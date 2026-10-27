<!--
  @component
  `Composer.Toolbar` — the row under the input: tools on the left, send on the right.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('flex items-center gap-2', className)}>{@render children?.()}</div>

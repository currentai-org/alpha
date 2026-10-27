<!--
  @component
  `Sidebar.Footer` — pinned bottom block (settings, account). Stays visible in the rail.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div class={cn('mt-auto flex shrink-0 flex-col gap-0.5 border-t border-line-1 p-2', className)}>
	<ul class="flex flex-col gap-0.5" role="list">{@render children?.()}</ul>
</div>

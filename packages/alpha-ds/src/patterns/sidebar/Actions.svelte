<!--
  @component
  `Sidebar.Actions` — the primary actions block under the header (New chat, Search). Children are
  usually `Sidebar.Item`s with `emphasis`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<ul role="list" class={cn('flex flex-col gap-0.5 px-2 pb-2', className)}>{@render children?.()}</ul>

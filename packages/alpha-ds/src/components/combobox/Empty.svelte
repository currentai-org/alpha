<!--
  @component
  Base UI `Combobox.Empty` — the line shown when nothing matches the query. Render it yourself when
  the filtered list is empty.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<p class={cn('px-2 py-1.5 type-caption text-fg-3', className)} role="status">
	{@render children?.()}
</p>

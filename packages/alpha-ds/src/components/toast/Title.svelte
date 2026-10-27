<!--
  @component
  Base UI `Toast.Title`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<p class={cn('type-body font-medium text-fg-1', className)}>{@render children?.()}</p>

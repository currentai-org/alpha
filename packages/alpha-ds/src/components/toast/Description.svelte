<!--
  @component
  Base UI `Toast.Description`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<p class={cn('type-caption text-fg-2', className)}>{@render children?.()}</p>

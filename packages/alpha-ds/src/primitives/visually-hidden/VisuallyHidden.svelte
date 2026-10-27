<!--
  @component
  VisuallyHidden — present for assistive technology, absent from the visual layout.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let { as = 'span', children }: { as?: string; children?: Snippet } = $props();
</script>

<svelte:element this={as} class="sr-only">{@render children?.()}</svelte:element>

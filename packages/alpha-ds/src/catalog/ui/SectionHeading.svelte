<script lang="ts">
	import type { Snippet } from 'svelte';

	let { id, children }: { id: string; children?: Snippet } = $props();
</script>

<h2 {id} class="group/h scroll-mt-24 border-b border-line-2 pb-2 type-heading text-fg-1">
	<a href="#{id}" class="no-underline"
		>{@render children?.()}<span
			class="ml-2 text-fg-3 opacity-0 group-hover/h:opacity-100"
			aria-hidden="true">#</span
		></a
	>
</h2>

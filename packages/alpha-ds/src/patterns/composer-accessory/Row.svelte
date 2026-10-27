<!--
  @component
  `ComposerAccessory.Row` — the strip of pills attached under (or over) the composer.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let {
		class: className,
		children,
		label = 'Message options'
	}: { class?: string; children?: Snippet; label?: string } = $props();
</script>

<div
	role="group"
	aria-label={label}
	class={cn('flex min-w-0 flex-wrap items-center gap-1.5 px-1 pt-1.5', className)}
>
	{@render children?.()}
</div>

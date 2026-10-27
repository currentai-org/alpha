<!--
  @component
  `Message.Content` — the body. Bubbles for the user, open text for the assistant (inherits from
  the enclosing `Message.Root`).
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';

	let { class: className, children }: { class?: string; children?: Snippet } = $props();
</script>

<div
	class={cn(
		'min-w-0 type-body text-fg-1',
		'group-data-[from=user]/message:max-w-[85%] group-data-[from=user]/message:border group-data-[from=user]/message:border-line-1 group-data-[from=user]/message:bg-surface-2 group-data-[from=user]/message:px-4 group-data-[from=user]/message:py-2.5',
		'group-data-[from=assistant]/message:w-full',
		className
	)}
>
	{@render children?.()}
</div>

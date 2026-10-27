<!--
  @component
  Frame — the brutalist window: a hard-ruled box with an optional title bar (chrome surface).
  The spec's one permanent shadow belongs here, on the outer app container, via `elevated`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';

	let {
		title,
		actions,
		elevated = false,
		weight = 'strong',
		class: className,
		children,
		...rest
	}: Omit<HTMLAttributes<HTMLElement>, 'title'> & {
		/** Title-bar content; omit for a bare frame. */
		title?: Snippet;
		/** Right side of the title bar. */
		actions?: Snippet;
		elevated?: boolean;
		weight?: 'hairline' | 'strong';
		children?: Snippet;
	} = $props();
</script>

<section
	{...rest}
	data-surface="1"
	class={cn(
		'flex min-h-0 flex-col overflow-hidden bg-surface-1 text-fg-1',
		weight === 'strong' ? 'border-2 border-line-strong' : 'border border-line-2',
		elevated && 'shadow-window',
		className
	)}
>
	{#if title}
		<header
			data-surface="chrome"
			class="flex h-header shrink-0 items-center justify-between gap-3 border-b border-line-2 bg-chrome px-3 text-fg-on-chrome"
		>
			<div class="flex min-w-0 items-center gap-2 type-label">{@render title()}</div>
			{#if actions}<div class="flex items-center gap-1">{@render actions()}</div>{/if}
		</header>
	{/if}
	<div class="flex min-h-0 flex-1 flex-col">{@render children?.()}</div>
</section>

<!--
  @component
  Center — a centred, max-width column (the reading measure). `thread` is the conversation width.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';

	let {
		width = 'thread',
		gutter = true,
		as = 'div',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> & {
		width?: 'prose' | 'thread' | 'wide' | 'full';
		gutter?: boolean;
		as?: string;
		children?: Snippet;
	} = $props();

	const widthClass = {
		prose: 'max-w-prose',
		thread: 'max-w-thread',
		wide: 'max-w-6xl',
		full: 'max-w-none'
	} as const;
</script>

<svelte:element
	this={as}
	{...rest}
	class={cn('mx-auto w-full', widthClass[width], gutter && 'px-4', className)}
>
	{@render children?.()}
</svelte:element>

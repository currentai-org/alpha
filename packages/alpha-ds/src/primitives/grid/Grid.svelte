<!--
  @component
  Grid — responsive columns. `min` makes an auto-fill grid (as many columns as fit at that
  minimum width); `cols` fixes the count.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { gapClass, type Gap } from '../layout.ts';

	let {
		cols,
		min = '16rem',
		gap = '4',
		ruled = false,
		as = 'div',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> & {
		cols?: 1 | 2 | 3 | 4 | 6;
		/** Minimum column width for auto-fill (ignored when `cols` is set). */
		min?: string;
		gap?: Gap;
		/** Brutalist ruled grid: hairlines between cells instead of gaps. */
		ruled?: boolean;
		as?: string;
		children?: Snippet;
	} = $props();

	const colClass = {
		1: 'grid-cols-1',
		2: 'sm:grid-cols-2',
		3: 'sm:grid-cols-2 lg:grid-cols-3',
		4: 'sm:grid-cols-2 lg:grid-cols-4',
		6: 'sm:grid-cols-3 lg:grid-cols-6'
	} as const;
</script>

<svelte:element
	this={as}
	{...rest}
	style:--grid-min={cols ? undefined : min}
	class={cn(
		'grid',
		cols
			? ['grid-cols-1', colClass[cols]]
			: 'grid-cols-[repeat(auto-fill,minmax(min(var(--grid-min),100%),1fr))]',
		ruled ? 'gap-px border border-line-surface bg-line-surface *:bg-surface' : gapClass[gap],
		className
	)}
>
	{@render children?.()}
</svelte:element>

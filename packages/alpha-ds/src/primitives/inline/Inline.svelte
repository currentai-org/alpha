<!--
  @component
  Inline — horizontal flow with a token gap; wraps by default. Use for toolbars, chip rows,
  label + control pairs.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import {
		alignClass,
		gapClass,
		justifyClass,
		type Align,
		type Gap,
		type Justify
	} from '../layout.ts';

	let {
		gap = '2',
		align = 'center',
		justify = 'start',
		wrap = true,
		as = 'div',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> & {
		gap?: Gap;
		align?: Align;
		justify?: Justify;
		wrap?: boolean;
		as?: string;
		children?: Snippet;
	} = $props();
</script>

<svelte:element
	this={as}
	{...rest}
	class={cn(
		'flex flex-row',
		wrap && 'flex-wrap',
		gapClass[gap],
		alignClass[align],
		justifyClass[justify],
		className
	)}
>
	{@render children?.()}
</svelte:element>

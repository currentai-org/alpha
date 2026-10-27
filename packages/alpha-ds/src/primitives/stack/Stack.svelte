<!--
  @component
  Stack — vertical flow with a token gap. Use for any column of things.
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
		gap = '4',
		align = 'stretch',
		justify = 'start',
		divided = false,
		as = 'div',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> & {
		gap?: Gap;
		align?: Align;
		justify?: Justify;
		/** Draw a contextual rule between children. */
		divided?: boolean;
		as?: string;
		children?: Snippet;
	} = $props();
</script>

<svelte:element
	this={as}
	{...rest}
	class={cn(
		'flex flex-col',
		gapClass[gap],
		alignClass[align],
		justifyClass[justify],
		divided && 'divide-y divide-line-surface',
		className
	)}
>
	{@render children?.()}
</svelte:element>

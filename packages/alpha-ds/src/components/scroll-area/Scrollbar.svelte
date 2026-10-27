<!--
  @component
  Base UI `ScrollArea.Scrollbar` (engine: bits-ui ScrollArea.Scrollbar). Renders its Thumb when
  no children are given.
-->
<script lang="ts">
	import { ScrollArea as Engine, type ScrollAreaScrollbarProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		orientation = 'vertical',
		class: className,
		children,
		...rest
	}: Omit<ScrollAreaScrollbarProps, 'orientation'> & {
		orientation?: ScrollAreaScrollbarProps['orientation'];
	} = $props();
</script>

<Engine.Scrollbar
	{orientation}
	{...rest}
	class={cn(
		'flex touch-none p-px transition-opacity select-none',
		orientation === 'vertical' ? 'h-full w-2' : 'h-2 w-full flex-col',
		className
	)}
>
	{#if children}{@render children()}{:else}<Engine.Thumb
			class="flex-1 bg-line-3 hover:bg-fg-2"
		/>{/if}
</Engine.Scrollbar>

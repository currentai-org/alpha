<!--
  @component
  Base UI `ScrollArea.Root` (engine: bits-ui ScrollArea.Root). Anatomy: Root › Viewport ›
  Content, plus Scrollbar › Thumb and Corner. Thin, square, ink scrollbars.
-->
<script lang="ts">
	import { ScrollArea as Engine, type ScrollAreaRootProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let { type = 'hover', class: className, children, ...rest }: ScrollAreaRootProps = $props();
</script>

<Engine.Root {type} {...rest} class={cn('relative overflow-hidden', className)}>
	{@render children?.()}
</Engine.Root>

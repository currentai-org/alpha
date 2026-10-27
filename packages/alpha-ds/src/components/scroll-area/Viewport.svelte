<!--
  @component
  Base UI `ScrollArea.Viewport` (engine: bits-ui ScrollArea.Viewport).
-->
<script lang="ts">
	import { ScrollArea as Engine, type ScrollAreaViewportProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';

	let {
		ref = $bindable(),
		class: className,
		children,
		...rest
	}: ScrollAreaViewportProps = $props();
</script>

<Engine.Viewport
	bind:ref={() => ref ?? null, (v) => (ref = v)}
	{...rest}
	class={cn('size-full', className)}
>
	{@render children?.()}
</Engine.Viewport>

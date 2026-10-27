<!--
  @component
  Base UI `Tooltip.Popup` (engine: bits-ui Tooltip.Content). Inverse surface, DM Mono micro —
  a transient label, not a panel.
-->
<script lang="ts">
	import { Tooltip as Engine, type TooltipContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { getPositioner } from '../../internal/positioner.ts';

	let {
		class: className,
		children,
		...rest
	}: Omit<TooltipContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> = $props();

	const position = getPositioner({ sideOffset: 4 });
</script>

<Engine.Content
	{...position}
	{...rest}
	class={cn(
		'z-tooltip max-w-64 motion-popup rounded-sharp bg-inverse px-2 py-1 type-label text-fg-inverse normal-case',
		className
	)}
>
	{@render children?.()}
</Engine.Content>

<!--
  @component
  Base UI `Popover.Popup` (engine: bits-ui Popover.Content). Placement comes from the enclosing
  `Popover.Positioner`.
-->
<script lang="ts">
	import { Popover as Engine, type PopoverContentProps } from 'bits-ui';
	import { cn, type VariantProps } from '../../internal/cn.ts';
	import { popupRecipe } from '../../internal/popup.recipe.ts';
	import { getPositioner } from '../../internal/positioner.ts';

	let {
		size,
		padded,
		class: className,
		children,
		...rest
	}: Omit<PopoverContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> &
		VariantProps<typeof popupRecipe> = $props();

	const position = getPositioner();
</script>

<Engine.Content
	{...position}
	{...rest}
	data-surface="3"
	class={cn(popupRecipe({ size, padded }), className)}
>
	{@render children?.()}
</Engine.Content>

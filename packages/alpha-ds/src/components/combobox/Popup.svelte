<!--
  @component
  Base UI `Combobox.Popup` (engine: bits-ui Combobox.Content + Viewport). Matches the input width.
  A long list fades at the edge that has more to scroll to.
-->
<script lang="ts">
	import { Combobox as Engine, type ComboboxContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { popupRecipe } from '../../internal/popup.recipe.ts';
	import { getPositioner } from '../../internal/positioner.ts';

	let {
		class: className,
		children,
		...rest
	}: Omit<ComboboxContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> = $props();

	const position = getPositioner({ sideOffset: 4 });
</script>

<Engine.Content
	{...position}
	{...rest}
	data-surface="3"
	class={cn(
		popupRecipe({ padded: false }),
		'max-h-[min(20rem,var(--bits-combobox-content-available-height))] min-w-(--bits-combobox-anchor-width) p-1',
		className
	)}
>
	<Engine.Viewport class="scroll-fade-y">{@render children?.()}</Engine.Viewport>
</Engine.Content>

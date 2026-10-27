<!--
  @component
  Base UI `Select.Popup` (engine: bits-ui Select.Content + Viewport). Matches the trigger width. A long list
  fades at the edge that has more to scroll to.
-->
<script lang="ts">
	import { Select as Engine, type SelectContentProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { popupRecipe } from '../../internal/popup.recipe.ts';
	import { getPositioner } from '../../internal/positioner.ts';

	let {
		class: className,
		children,
		...rest
	}: Omit<SelectContentProps, 'side' | 'align' | 'sideOffset' | 'alignOffset'> = $props();

	const position = getPositioner({ sideOffset: 4 });
</script>

<Engine.Content
	{...position}
	{...rest}
	data-surface="3"
	class={cn(
		popupRecipe({ padded: false }),
		'max-h-(--bits-select-content-available-height) min-w-(--bits-select-anchor-width) p-1',
		className
	)}
>
	<Engine.Viewport class="scroll-fade-y">{@render children?.()}</Engine.Viewport>
</Engine.Content>

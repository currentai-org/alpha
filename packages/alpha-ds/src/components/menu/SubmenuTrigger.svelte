<!--
  @component
  Base UI `Menu.SubmenuTrigger` (engine: bits-ui DropdownMenu.SubTrigger). An item row with a
  trailing chevron; opens its submenu on hover, click, or the right arrow key.
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuSubTriggerProps } from 'bits-ui';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let { class: className, children, ...rest }: DropdownMenuSubTriggerProps = $props();
</script>

<Engine.SubTrigger {...rest} class={cn(itemRecipe(), 'pr-2 ui-open:bg-tint-hover', className)}>
	<!-- Children fill the row, so a trailing value (e.g. "System") can right-align with ml-auto
	     against the chevron instead of splitting the space with it. -->
	<span class="flex min-w-0 flex-1 items-center gap-2">{@render children?.()}</span>
	<RiArrowRightSLine aria-hidden="true" class="shrink-0 text-fg-3" />
</Engine.SubTrigger>

<!--
  @component
  Base UI `Menu.Item` (engine: bits-ui DropdownMenu.Item). `tone="destructive"` keeps the label
  Text 1 and colours only the icon Accent 2 (spec); `tone="cta"` is a menu's single primary action. Base UI's `onClick` maps to `onSelect`.
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuItemProps } from 'bits-ui';
	import { cn, type VariantProps } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		tone,
		class: className,
		children,
		...rest
	}: DropdownMenuItemProps & VariantProps<typeof itemRecipe> = $props();
</script>

<Engine.Item {...rest} class={cn(itemRecipe({ tone }), className)}
	>{@render children?.()}</Engine.Item
>

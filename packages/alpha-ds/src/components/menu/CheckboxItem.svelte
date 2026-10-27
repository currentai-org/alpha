<!--
  @component
  Base UI `Menu.CheckboxItem` (engine: bits-ui DropdownMenu.CheckboxItem). Draws its own
  indicator (Base UI's `Menu.CheckboxItemIndicator` is folded in).
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuCheckboxItemProps } from 'bits-ui';
	import RiCheckLine from '~icons/ri/check-line';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		checked = $bindable(false),
		class: className,
		children,
		...rest
	}: Omit<DropdownMenuCheckboxItemProps, 'children'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.CheckboxItem bind:checked {...rest} class={cn(itemRecipe(), 'pr-8', className)}>
	{@render children?.()}
	{#if checked}<RiCheckLine class="absolute right-2 text-fg-1" aria-hidden="true" />{/if}
</Engine.CheckboxItem>

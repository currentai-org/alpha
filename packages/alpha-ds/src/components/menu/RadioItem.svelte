<!--
  @component
  Base UI `Menu.RadioItem` (engine: bits-ui DropdownMenu.RadioItem), indicator folded in.
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuRadioItemProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		class: className,
		children: label,
		...rest
	}: Omit<DropdownMenuRadioItemProps, 'children'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.RadioItem {...rest} class={cn(itemRecipe(), 'group/radio pr-8', className)}>
	{#snippet children({ checked })}
		{@render label?.()}
		{#if checked}<span class="absolute right-3 size-1.5 rounded-sharp bg-fg-1" aria-hidden="true"
			></span>{/if}
	{/snippet}
</Engine.RadioItem>

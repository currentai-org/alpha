<!--
  @component
  Base UI `Combobox.Item` (engine: bits-ui Combobox.Item). Draws its check when selected.
-->
<script lang="ts">
	import { Combobox as Engine, type ComboboxItemProps } from 'bits-ui';
	import RiCheckLine from '~icons/ri/check-line';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		class: className,
		children: label,
		...rest
	}: Omit<ComboboxItemProps, 'children'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.Item {...rest} class={cn(itemRecipe(), 'pr-8', className)}>
	{#snippet children({ selected })}
		{#if label}{@render label()}{:else}{rest.label ?? rest.value}{/if}
		{#if selected}<RiCheckLine class="absolute right-2 text-fg-1" aria-hidden="true" />{/if}
	{/snippet}
</Engine.Item>

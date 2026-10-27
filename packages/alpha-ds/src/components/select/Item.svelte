<!--
  @component
  Base UI `Select.Item` (engine: bits-ui Select.Item). Put `Select.ItemText` and
  `Select.ItemIndicator` inside, or just text.
-->
<script lang="ts">
	import { Select as Engine, type SelectItemProps } from 'bits-ui';
	import RiCheckLine from '~icons/ri/check-line';
	import { cn } from '../../internal/cn.ts';
	import { itemRecipe } from '../../internal/popup.recipe.ts';

	let {
		class: className,
		children: label,
		...rest
	}: Omit<SelectItemProps, 'children'> & {
		children?: import('svelte').Snippet;
	} = $props();
</script>

<Engine.Item {...rest} class={cn(itemRecipe(), 'pr-8', className)}>
	{#snippet children({ selected })}
		{#if label}{@render label()}{:else}{rest.label ?? rest.value}{/if}
		{#if selected}<RiCheckLine class="absolute right-2 text-fg-1" aria-hidden="true" />{/if}
	{/snippet}
</Engine.Item>

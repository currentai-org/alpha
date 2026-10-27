<!--
  @component
  Base UI `Input` — a native `<input>` that joins an enclosing `Field` automatically.
-->
<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';
	import { inputRecipe, type InputVariants } from './input.recipe.ts';

	let {
		value = $bindable(),
		ref = $bindable(),
		size,
		appearance,
		class: className,
		...rest
	}: Omit<HTMLInputAttributes, 'size'> &
		InputVariants & { ref?: HTMLInputElement | null } = $props();

	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));
</script>

<input
	bind:this={ref}
	bind:value
	{...rest}
	{...wired}
	data-disabled={rest.disabled || field?.disabled ? '' : undefined}
	class={cn(inputRecipe({ size, appearance }), className)}
/>

<!--
  @component
  Multi-line text field. Alpha-only (Base UI renders a textarea through `Field.Control`); shares
  the Input skin and grows with its content up to `maxRows`.
-->
<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import { cn, tv } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';
	import { inputRecipe } from '../input/input.recipe.ts';

	const textareaRecipe = tv({
		extend: inputRecipe,
		base: 'h-auto resize-none py-2 leading-body field-sizing-content',
		variants: { size: { sm: 'h-auto', md: 'h-auto', lg: 'h-auto' } }
	});

	let {
		value = $bindable(),
		ref = $bindable(),
		minRows = 2,
		maxRows = 8,
		class: className,
		...rest
	}: HTMLTextareaAttributes & {
		ref?: HTMLTextAreaElement | null;
		/** Visible rows before content grows it. */
		minRows?: number;
		/** Rows after which it scrolls instead of growing. */
		maxRows?: number;
	} = $props();

	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));
</script>

<textarea
	bind:this={ref}
	bind:value
	rows={minRows}
	{...rest}
	{...wired}
	style:min-height="calc({minRows} * var(--ds-leading-body) + var(--ds-space-4))"
	style:max-height="calc({maxRows} * var(--ds-leading-body) + var(--ds-space-4))"
	data-disabled={rest.disabled || field?.disabled ? '' : undefined}
	class={cn(textareaRecipe(), className)}></textarea>

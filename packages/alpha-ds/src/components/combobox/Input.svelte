<!--
  @component
  Base UI `Combobox.Input` (engine: bits-ui Combobox.Input + Combobox.Trigger). Input skin with
  the disclosure chevron inside it; joins a Field. A click on the input opens the list too, so it
  works like a Select for someone who never types.
-->
<script lang="ts">
	import { Combobox as Engine, type ComboboxInputProps } from 'bits-ui';
	import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';
	import { cn } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';
	import { inputRecipe, type InputVariants } from '../input/input.recipe.ts';
	import { getComboboxContext } from './context.ts';

	let {
		size,
		class: className,
		triggerLabel = 'Show options',
		onclick,
		...rest
	}: Omit<ComboboxInputProps, 'child'> &
		InputVariants & {
			/** Accessible name of the chevron button. */
			triggerLabel?: string;
		} = $props();
	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));
	const combobox = getComboboxContext();
</script>

<span class={cn('relative flex w-full items-center', className)}>
	<Engine.Input
		{...rest}
		{...wired}
		onclick={(e) => {
			onclick?.(e);
			combobox?.openList();
		}}
		class={cn(inputRecipe({ size }), 'pr-9 ui-open:border-line-3')}
	/>
	<Engine.Trigger
		aria-label={triggerLabel}
		class="absolute right-1 grid size-7 place-items-center rounded-field text-fg-2 hover:text-fg-1"
	>
		<RiArrowDownSLine class="size-4" aria-hidden="true" />
	</Engine.Trigger>
</span>

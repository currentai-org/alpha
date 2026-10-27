<!--
  @component
  Base UI `Select.Trigger` (engine: bits-ui Select.Trigger). Styled like an Input; put
  `Select.Value` and `Select.Icon` inside.
-->
<script lang="ts">
	import { Select as Engine, type SelectTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { fieldControlProps, getFieldContext } from '../../internal/field-context.ts';
	import { inputRecipe, type InputVariants } from '../input/input.recipe.ts';

	let { size, class: className, children, ...rest }: SelectTriggerProps & InputVariants = $props();
	const field = getFieldContext();
	const wired = $derived(fieldControlProps(field, { id: rest.id }));
</script>

<Engine.Trigger
	{...rest}
	{...wired}
	class={cn(
		inputRecipe({ size }),
		'inline-flex items-center justify-between gap-2 text-left ui-open:border-line-3',
		className
	)}
>
	{@render children?.()}
</Engine.Trigger>

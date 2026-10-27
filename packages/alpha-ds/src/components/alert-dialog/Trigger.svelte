<!--
  @component
  Base UI `AlertDialog.Trigger` (engine: bits-ui AlertDialog.Trigger). Styled as a Button.
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant,
		size,
		shape,
		casing,
		class: className,
		children,
		...rest
	}: AlertDialogTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger
	{...rest}
	class={rest.child ? className : cn(buttonRecipe({ variant, size, shape, casing }), className)}
>
	{@render children?.()}
</Engine.Trigger>

<!--
  @component
  Confirming button of an alert dialog (engine: bits-ui AlertDialog.Action). Alpha addition —
  Base UI composes this from a Button + `onClick`; bits-ui gives it focus/close semantics.
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogActionProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'primary',
		size,
		class: className,
		children,
		...rest
	}: AlertDialogActionProps & ButtonVariants = $props();
</script>

<Engine.Action {...rest} class={cn(buttonRecipe({ variant, size }), className)}
	>{@render children?.()}</Engine.Action
>

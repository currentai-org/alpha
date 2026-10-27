<!--
  @component
  Base UI `AlertDialog.Close` — dismisses without acting (engine: bits-ui AlertDialog.Cancel).
  Use `AlertDialog.Action` for the confirming button.
-->
<script lang="ts">
	import { AlertDialog as Engine, type AlertDialogCancelProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'secondary',
		size,
		class: className,
		children,
		...rest
	}: AlertDialogCancelProps & ButtonVariants = $props();
</script>

<Engine.Cancel {...rest} class={cn(buttonRecipe({ variant, size }), className)}
	>{@render children?.()}</Engine.Cancel
>

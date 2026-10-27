<!--
  @component
  Base UI `Popover.Close` (engine: bits-ui Popover.Close). Styled as a Button.
-->
<script lang="ts">
	import { Popover as Engine, type PopoverCloseProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'secondary',
		size = 'sm',
		class: className,
		children,
		...rest
	}: PopoverCloseProps & ButtonVariants = $props();
</script>

<Engine.Close {...rest} class={cn(buttonRecipe({ variant, size }), className)}
	>{@render children?.()}</Engine.Close
>

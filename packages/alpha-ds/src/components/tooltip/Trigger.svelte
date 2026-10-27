<!--
  @component
  Base UI `Tooltip.Trigger` (engine: bits-ui Tooltip.Trigger). Unstyled by default (it usually
  wraps an existing control via `child`); pass `variant` to style it as a Button.
-->
<script lang="ts">
	import { Tooltip as Engine, type TooltipTriggerProps } from 'bits-ui';
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
	}: TooltipTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger
	{...rest}
	class={variant ? cn(buttonRecipe({ variant, size, shape, casing }), className) : cn(className)}
>
	{@render children?.()}
</Engine.Trigger>

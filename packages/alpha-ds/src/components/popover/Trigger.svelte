<!--
  @component
  Base UI `Popover.Trigger` (engine: bits-ui Popover.Trigger). Styled as a Button (same variants); pass
  `child` to render your own element instead.
-->
<script lang="ts">
	import { Popover as Engine, type PopoverTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'secondary',
		size,
		shape,
		casing,
		class: className,
		children,
		...rest
	}: PopoverTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger
	{...rest}
	class={rest.child ? className : cn(buttonRecipe({ variant, size, shape, casing }), className)}
>
	{@render children?.()}
</Engine.Trigger>

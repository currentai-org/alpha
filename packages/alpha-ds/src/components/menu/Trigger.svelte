<!--
  @component
  Base UI `Menu.Trigger` (engine: bits-ui DropdownMenu.Trigger). Styled as a Button (same variants); pass
  `child` to render your own element instead.
-->
<script lang="ts">
	import { DropdownMenu as Engine, type DropdownMenuTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'ghost',
		size,
		shape,
		casing,
		class: className,
		children,
		...rest
	}: DropdownMenuTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger
	{...rest}
	class={rest.child ? className : cn(buttonRecipe({ variant, size, shape, casing }), className)}
>
	{@render children?.()}
</Engine.Trigger>

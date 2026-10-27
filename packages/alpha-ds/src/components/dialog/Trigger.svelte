<!--
  @component
  Base UI `Dialog.Trigger` (engine: bits-ui Dialog.Trigger). Styled as a Button (same variants).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogTriggerProps } from 'bits-ui';
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
	}: DialogTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger
	{...rest}
	class={rest.child ? className : cn(buttonRecipe({ variant, size, shape, casing }), className)}
>
	{@render children?.()}
</Engine.Trigger>

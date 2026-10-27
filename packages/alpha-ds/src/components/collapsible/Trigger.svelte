<!--
  @component
  Base UI `Collapsible.Trigger` (engine: bits-ui Collapsible.Trigger). Styled as a Button;
  accepts the Button variants.
-->
<script lang="ts">
	import { Collapsible as Engine, type CollapsibleTriggerProps } from 'bits-ui';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant = 'ghost',
		size = 'sm',
		class: className,
		children,
		...rest
	}: CollapsibleTriggerProps & ButtonVariants = $props();
</script>

<Engine.Trigger {...rest} class={cn(buttonRecipe({ variant, size }), className)}>
	{@render children?.()}
</Engine.Trigger>

<!--
  @component
  Base UI `Dialog.Close` (engine: bits-ui Dialog.Close). Styled as a Button; with no children it
  renders the standard icon close (top-right, ghost, Remix close-line).
-->
<script lang="ts">
	import { Dialog as Engine, type DialogCloseProps } from 'bits-ui';
	import RiCloseLine from '~icons/ri/close-line';
	import { cn } from '../../internal/cn.ts';
	import { buttonRecipe, type ButtonVariants } from '../button/button.recipe.ts';

	let {
		variant,
		size,
		shape,
		class: className,
		children,
		...rest
	}: DialogCloseProps & ButtonVariants = $props();
	const iconOnly = $derived(!children && !rest.child);
</script>

<Engine.Close
	aria-label={iconOnly ? 'Close' : undefined}
	{...rest}
	class={cn(
		buttonRecipe({
			variant: variant ?? (iconOnly ? 'ghost' : 'secondary'),
			size: size ?? (iconOnly ? 'icon-sm' : 'md'),
			shape
		}),
		iconOnly && 'absolute top-3 right-3',
		className
	)}
>
	{#if iconOnly}<RiCloseLine aria-hidden="true" />{:else}{@render children?.()}{/if}
</Engine.Close>

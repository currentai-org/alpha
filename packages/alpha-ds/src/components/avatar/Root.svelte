<!--
  @component
  Base UI `Avatar.Root` (engine: bits-ui Avatar.Root). Square — sharp, per spec.
-->
<script lang="ts">
	import { Avatar as Engine, type AvatarRootProps } from 'bits-ui';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';

	const avatarRecipe = tv({
		base: 'relative inline-flex shrink-0 items-center justify-center overflow-hidden border border-line-2 bg-surface-3 rounded-sharp select-none',
		variants: {
			size: { sm: 'size-6 text-micro', md: 'size-8 text-small', lg: 'size-10 text-body' }
		},
		defaultVariants: { size: 'md' }
	});

	let {
		size,
		class: className,
		children,
		...rest
	}: AvatarRootProps & VariantProps<typeof avatarRecipe> = $props();
</script>

<Engine.Root {...rest} class={cn(avatarRecipe({ size }), className)}>
	{@render children?.()}
</Engine.Root>

<!--
  @component
  Base UI `Separator` (engine: bits-ui Separator.Root). Border 2 by default; follows the surface
  context (Border 3 on Background 3).
-->
<script lang="ts">
	import { Separator as Engine, type SeparatorRootProps } from 'bits-ui';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';

	const separatorRecipe = tv({
		base: 'shrink-0 bg-line-surface',
		variants: {
			orientation: { horizontal: 'h-px w-full', vertical: 'h-full w-px self-stretch' },
			weight: { subtle: 'bg-line-1', default: '', strong: 'bg-line-strong' }
		},
		defaultVariants: { orientation: 'horizontal', weight: 'default' }
	});

	let {
		orientation = 'horizontal',
		weight,
		class: className,
		...rest
	}: Omit<SeparatorRootProps, 'children' | 'child'> &
		VariantProps<typeof separatorRecipe> = $props();
</script>

<Engine.Root
	{orientation}
	{...rest}
	class={cn(separatorRecipe({ orientation, weight }), className)}
/>

<!--
  @component
  Surface — the only way to put a background tier on the page. Sets the fill AND the surface
  context (`data-surface`), so everything inside resolves "one tier up" fills and the right rule
  weight automatically (spec: the surface underneath decides, not the component).

  level 1 = page · 2 = inset (cards, composer) · 3 = floating (panels) · chrome = top bar
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';
	import type { SurfaceLevel } from '../../internal/types.ts';

	const surfaceRecipe = tv({
		base: 'text-fg-1',
		variants: {
			level: {
				'1': 'bg-surface-1',
				'2': 'bg-surface-2',
				'3': 'bg-surface-3',
				chrome: 'bg-chrome text-fg-on-chrome'
			},
			/** Border weight. `auto` = the contextual rule for this level. */
			border: {
				none: '',
				auto: 'border border-line-surface',
				subtle: 'border border-line-1',
				strong: 'border border-line-strong'
			},
			padding: { none: '', sm: 'p-3', md: 'p-4', lg: 'p-6' }
		},
		// A bordered surface is a container: it takes the theme's card radius (square in Alpha).
		compoundVariants: [{ border: ['auto', 'subtle', 'strong'], class: 'rounded-card' }],
		defaultVariants: { level: '1', border: 'none', padding: 'none' }
	});

	let {
		level = '1',
		border,
		padding,
		as = 'div',
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLElement> &
		VariantProps<typeof surfaceRecipe> & {
			level?: SurfaceLevel;
			as?: string;
			children?: Snippet;
		} = $props();
</script>

<svelte:element
	this={as}
	{...rest}
	data-surface={level}
	class={cn(surfaceRecipe({ level, border, padding }), className)}
>
	{@render children?.()}
</svelte:element>

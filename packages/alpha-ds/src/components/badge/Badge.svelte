<!--
  @component
  Badge — a label-sized tag. Alpha addition (no Base UI equivalent). The `accent` tone is the
  spec's "small tag or badge fill": badge-sized only; what sits inside stays Text 1.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';

	const badgeRecipe = tv({
		base: 'inline-flex h-5 shrink-0 items-center gap-1 px-1.5 type-label whitespace-nowrap rounded-sharp [&_svg]:size-3',
		variants: {
			tone: {
				outline: 'border border-line-surface text-fg-2',
				solid: 'bg-fg-1 text-surface-1',
				accent: 'bg-accent-1 text-fg-on-accent',
				positive: 'border border-positive text-positive-text',
				caution: 'border border-caution text-caution-text',
				destructive: 'border border-accent-2 text-accent-2-text'
			}
		},
		defaultVariants: { tone: 'outline' }
	});

	let {
		tone,
		class: className,
		children,
		...rest
	}: HTMLAttributes<HTMLSpanElement> &
		VariantProps<typeof badgeRecipe> & { children?: Snippet } = $props();
</script>

<span {...rest} class={cn(badgeRecipe({ tone }), className)}>{@render children?.()}</span>

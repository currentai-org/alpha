<!--
  @component
  Icon wrapper for Remix Icon components (`~icons/ri/*`). Encodes the spec's colour rules:
  line icons are always Text 1; fill icons may be Accent 1 (the one primary action) or Accent 2
  (destructive). Decorative by default; pass `label` for a meaningful standalone icon.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { iconRecipe, type IconVariants } from './icon.recipe.ts';

	let {
		icon: Glyph,
		size,
		tone,
		label,
		class: className
	}: IconVariants & {
		/** A Remix Icon component, e.g. `import RiAddLine from '~icons/ri/add-line'`. */
		icon: Component<Record<string, unknown>>;
		/** Accessible name. Omit for decorative icons next to a text label. */
		label?: string;
		class?: string;
	} = $props();
</script>

<Glyph
	class={cn(iconRecipe({ size, tone }), className)}
	data-icon=""
	aria-hidden={label ? undefined : 'true'}
	aria-label={label}
	role={label ? 'img' : undefined}
/>

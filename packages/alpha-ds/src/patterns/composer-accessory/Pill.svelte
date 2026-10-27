<!--
  @component
  `ComposerAccessory.Pill` — toggles the `Panel` with the same `value`. Carries `aria-expanded` and
  `aria-controls`, so it reads as a disclosure button.
-->
<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { cn } from '../../internal/cn.ts';
	import { getComposerAccessory } from './context.ts';
	import { pillRecipe } from './composer-accessory.recipe.ts';

	let {
		value,
		icon: Glyph,
		tone = 'default',
		class: className,
		children,
		label
	}: {
		value: string;
		icon?: Component<Record<string, unknown>>;
		/** `xray` — the radiograph look for the XRAY entry point. `seed` — a language Alpha is still learning. */
		tone?: 'default' | 'xray' | 'seed';
		class?: string;
		children?: Snippet;
		/** Accessible name when the visible text is terse. */
		label?: string;
	} = $props();

	const ctx = getComposerAccessory();
	const expanded = $derived(ctx.open === value);
</script>

<button
	type="button"
	class={cn(pillRecipe({ tone }), className)}
	aria-expanded={expanded}
	aria-controls="{ctx.baseId}-{value}"
	aria-label={label}
	data-accessory-pill={value}
	onclick={() => ctx.toggle(value)}
>
	{#if Glyph}<Glyph aria-hidden="true" />{/if}
	<span class="min-w-0 truncate">{@render children?.()}</span>
</button>

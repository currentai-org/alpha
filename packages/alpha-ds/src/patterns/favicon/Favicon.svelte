<!--
  @component
  `Favicon` — the icon of the site a link points to, drawn at the start of that link. It is
  decorative: the link text names the site. When there is no `src`, or the image fails to load, it
  draws a globe in the same box, so a list of links keeps one left edge.
-->
<script lang="ts">
	import RiGlobalLine from '~icons/ri/global-line';
	import { cn, tv, type VariantProps } from '../../internal/cn.ts';

	const favicon = tv({
		base: 'inline-block shrink-0 object-contain',
		variants: { size: { xs: 'size-3', sm: 'size-3.5', md: 'size-4' } },
		defaultVariants: { size: 'sm' }
	});

	let {
		src,
		size,
		class: className
	}: VariantProps<typeof favicon> & {
		/** Image URL for the icon. Unset, or failing to load, draws the globe. */
		src?: string | null;
		class?: string;
	} = $props();

	// Keyed by URL, so a new `src` gets its own attempt rather than inheriting the last failure.
	let failed = $state<string | null>(null);
</script>

{#if src && failed !== src}
	<img
		{src}
		alt=""
		aria-hidden="true"
		loading="lazy"
		decoding="async"
		referrerpolicy="no-referrer"
		class={cn(favicon({ size }), className)}
		data-favicon=""
		onerror={() => (failed = src)}
	/>
{:else}
	<RiGlobalLine
		aria-hidden="true"
		class={cn(favicon({ size }), 'text-fg-3', className)}
		data-favicon="fallback"
	/>
{/if}

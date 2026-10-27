<script lang="ts">
	import { cn, type WithElementRef } from '$lib/utils.js';
	import { getEmblaContext } from './context.js';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		count,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		/**
		 * Slide count to assume before Embla has initialised. `scrollSnaps` is only populated on
		 * the client, so without this the dots would pop in after hydration and shift the layout.
		 */
		count?: number;
	} = $props();

	const emblaCtx = getEmblaContext('<Carousel.Dots/>');
	const snapCount = $derived(emblaCtx.scrollSnaps.length || (count ?? 0));
</script>

{#if snapCount > 1}
	<div
		bind:this={ref}
		data-slot="carousel-dots"
		class={cn('flex items-center gap-[3px]', className)}
		{...restProps}
	>
		{#each { length: snapCount } as _, i (i)}
			<button
				type="button"
				aria-label="Go to slide {i + 1}"
				aria-current={i === emblaCtx.selectedIndex ? 'true' : undefined}
				onclick={() => emblaCtx.scrollTo(i)}
				class={cn(
					// The dot is 6px per the design, far under the minimum touch target, so `before`
					// stretches an invisible hit area over it without affecting layout. It grows to the
					// 9px pitch horizontally and no further: at 3px spacing a symmetric expansion makes
					// neighbouring hit areas overlap, and the later sibling then paints over — and
					// swallows every click meant for — the dot before it.
					'relative size-1.5 cursor-pointer rounded-full transition-colors before:absolute before:inset-x-[-1.5px] before:inset-y-[-9px] before:content-[""]',
					i === emblaCtx.selectedIndex ? 'bg-medium-grey' : 'bg-light-grey/40'
				)}
			></button>
		{/each}
	</div>
{/if}

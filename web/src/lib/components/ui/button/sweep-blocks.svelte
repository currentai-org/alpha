<script lang="ts">
	import { cn } from '$lib/utils.js';

	// The hover wipe shared by the buttons and the recent-updates tile. The host must be a
	// `group/button` with `relative overflow-hidden`, and its content `relative z-1`.
	let { fill }: { fill: string } = $props();

	// Written as literal strings so Tailwind's scanner emits them, and scoped to `group-hover` so
	// the columns stagger on the way in but retract together.
	const BLOCK_DELAYS = [
		'group-hover/button:delay-0',
		'group-hover/button:delay-[90ms]',
		'group-hover/button:delay-[180ms]'
	];
</script>

<!-- The wipe: three columns, flattened to nothing and growing up from their bottom edge. `-ml-px`
     overlaps them so no hairline seam shows through mid-grow.

     `-inset-0.5`, not `inset-0`: buttons land on fractional pixels (for example 140.046875px wide,
     splitting into columns of 46.671875 / 46.6875 / 46.6875), so a wipe sized exactly to the box
     has antialiased outer edges and the button's own background bleeds through them as a hairline,
     visible or not depending on where the button falls on the device pixel grid. Oversizing by 2px
     puts those soft edges outside the clip, leaving the button's own `overflow-hidden` to cut a
     clean boundary instead. -->
<span class="absolute -inset-0.5 z-0 flex" aria-hidden="true">
	{#each BLOCK_DELAYS as delay (delay)}
		<span
			class={cn(
				'-ml-px flex-1 origin-bottom scale-y-0 transition-transform duration-[450ms] ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover/button:scale-y-100 first:ml-0 motion-reduce:transition-none',
				fill,
				delay
			)}
		></span>
	{/each}
</span>

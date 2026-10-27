<!--
  @component
  `Ticker` — one line of text that may not fit. Instead of an ellipsis, the clipped edge fades out.
  While its host (the row, button or menu item around it) is hovered or keyboard-focused, the text
  scrolls to its end, pauses, fades back to the start, pauses, and loops. Text that fits renders
  plain. Reduced motion keeps the fade and never scrolls.
-->
<script lang="ts" module>
	/** What counts as the ticker's host when `play` is left to it: the nearest of these around it. */
	const HOST =
		'[data-ticker-host], button, a, label, [role^="menuitem"], [role="option"], [role="radio"], [role="tab"]';
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { on } from 'svelte/events';
	import { prefersReducedMotion } from 'svelte/motion';
	import { cn } from '../../internal/cn.ts';

	let {
		children,
		play,
		speed = 40,
		pause = 1200,
		fade = 16,
		class: className
	}: {
		children: Snippet;
		/** Scroll now. Leave unset to scroll while the host is hovered or keyboard-focused. */
		play?: boolean;
		/** Scroll speed in px per second. */
		speed?: number;
		/** Pause at each end, in ms. */
		pause?: number;
		/** Length of the edge fade, in px. */
		fade?: number;
		class?: string;
	} = $props();

	let root = $state<HTMLElement>();
	let track = $state<HTMLElement>();
	/** How far the text runs past the visible width, in px; 0 when it fits. */
	let overflow = $state(0);
	let pointerIn = $state(false);
	let keyboardIn = $state(false);

	const playing = $derived(
		(play ?? (pointerIn || keyboardIn)) && overflow > 0 && !prefersReducedMotion.current
	);

	$effect(() => {
		if (!root || !track) return;
		const box = root;
		const text = track;
		const measure = () => (overflow = Math.max(0, Math.ceil(text.offsetWidth - box.clientWidth)));
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		observer.observe(text);
		measure();
		return () => observer.disconnect();
	});

	$effect(() => {
		if (play !== undefined || !root) return;
		const host = root.closest<HTMLElement>(HOST) ?? root;
		const enter = () => (pointerIn = true);
		const leave = () => (pointerIn = false);
		// Keyboard focus only: menus also focus the item under the pointer, which would keep a row
		// scrolling after the pointer has left it.
		const focus = () => (keyboardIn = host.matches(':focus-visible, :has(:focus-visible)'));
		const blur = () => (keyboardIn = false);
		const off = [
			on(host, 'pointerenter', enter),
			on(host, 'pointerleave', leave),
			on(host, 'focusin', focus),
			on(host, 'focusout', blur)
		];
		return () => off.forEach((stop) => stop());
	});

	$effect(() => {
		if (!playing || !root || !track) return;
		const distance = overflow;
		const travel = (distance / speed) * 1000;
		const ramp = Math.min(travel / 4, 250);
		const swap = 160;
		const total = pause + travel + pause + swap * 2;
		const at = (ms: number) => ms / total;
		const end = `translateX(${-distance}px)`;
		const F = `${fade}px`;

		// Start → pause → scroll to the end → pause → fade out, jump back, fade in. The last frame
		// matches the first, so the loop has no seam.
		const scroll = track.animate(
			[
				{ offset: 0, transform: 'translateX(0)', opacity: 1 },
				{ offset: at(pause), transform: 'translateX(0)', easing: 'ease-in-out' },
				{ offset: at(pause + travel), transform: end },
				{ offset: at(pause + travel + pause), transform: end, opacity: 1 },
				{ offset: at(pause + travel + pause + swap), transform: end, opacity: 0 },
				{
					offset: at(pause + travel + pause + swap) + 1e-4,
					transform: 'translateX(0)',
					opacity: 0
				},
				{ offset: 1, transform: 'translateX(0)', opacity: 1 }
			],
			{ duration: total, iterations: Infinity }
		);
		// The fade follows the text: only the right edge at the start, both while moving, only the
		// left at the end. These are scroll-fade-x's registered lengths, so they interpolate, and a
		// script animation outranks that utility's own scroll-driven one while it runs.
		const mask = root.animate(
			[
				{ offset: 0, '--ds-fade-start': '0px', '--ds-fade-end': F },
				{ offset: at(pause), '--ds-fade-start': '0px', '--ds-fade-end': F },
				{ offset: at(pause + ramp), '--ds-fade-start': F, '--ds-fade-end': F },
				{ offset: at(pause + travel - ramp), '--ds-fade-start': F, '--ds-fade-end': F },
				{ offset: at(pause + travel), '--ds-fade-start': F, '--ds-fade-end': '0px' },
				{ offset: at(pause + travel + pause + swap), '--ds-fade-start': F, '--ds-fade-end': '0px' },
				{
					offset: at(pause + travel + pause + swap) + 1e-4,
					'--ds-fade-start': '0px',
					'--ds-fade-end': F
				},
				{ offset: 1, '--ds-fade-start': '0px', '--ds-fade-end': F }
			],
			{ duration: total, iterations: Infinity }
		);
		return () => {
			scroll.cancel();
			mask.cancel();
		};
	});
</script>

<!-- At rest scroll-fade-x does the masking: an overflowing line sits at scroll 0, which fades the
     right edge only; a line that fits has no scroll range, so no fade. -->
<span
	bind:this={root}
	data-overflowing={overflow > 0 ? '' : undefined}
	data-playing={playing ? '' : undefined}
	class={cn('block min-w-0 scroll-fade-x overflow-hidden whitespace-nowrap', className)}
	style:--ds-scroll-fade="{fade}px"
>
	<span bind:this={track} class="inline-block" class:will-change-transform={playing}>
		{@render children()}
	</span>
</span>

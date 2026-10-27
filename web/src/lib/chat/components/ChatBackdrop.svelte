<script lang="ts">
	import { onMount } from 'svelte';
	import {
		createAlphaPotluckField,
		type PotluckFieldHandle
	} from '$lib/alpha-landing/alpha-potluck-field';

	/**
	 * The Bold /alpha page's two backdrops blended behind the new-chat screen: the hero's octagon dot
	 * grid with colour drifting through it, gathering now and then into a small heap of pattern pieces
	 * like the closing section's. Slow and dim on its own, so it never competes with the composer, and
	 * it plays along with the pointer on the open ground around the greeting: dots swell and leave a
	 * trail, a click ripples out and gathers a heap, a click on a heap knocks it over. The canvas
	 * itself takes no pointer events; it listens on the scroller it sits in, and leaves clicks on
	 * controls and on the greeting alone. Theme-aware: the three tones are shades of Accent 1 (the
	 * accent, a lighter warmer one, a deeper cooler one), the grid is Text 1, all read from the live
	 * tokens through hidden probes, so it follows every theme and light/dark switch. It draws transparent and
	 * is masked to fade out toward the edges, so it blends into the surface instead of sitting on it
	 * as a picture. Heaps keep clear of the element
	 * marked `data-backdrop-exclude`. Decorative only: aria-hidden, no pointer events, still under
	 * reduced motion.
	 */
	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let toneProbes = $state<HTMLSpanElement[]>([]);
	let lineProbe = $state<HTMLSpanElement>();
	let painted = $state(false);

	onMount(() => {
		const [a, b, c] = toneProbes;
		if (!host || !canvas || !a || !b || !c || !lineProbe) return;
		const hostEl = host;
		const canvasEl = canvas;
		const l = lineProbe;
		const color = (el: HTMLElement) => getComputedStyle(el).color;
		let handle: PotluckFieldHandle | null = null;
		let cancelled = false;

		const boot = () => {
			if (cancelled) return;
			try {
				handle = createAlphaPotluckField({
					canvas: canvasEl,
					host: hostEl,
					palette: () => ({ tones: [color(a), color(b), color(c)], line: color(l) }),
					pointerTarget: hostEl.parentElement ?? undefined,
					exclude: () =>
						hostEl.parentElement?.querySelector<HTMLElement>('[data-backdrop-exclude]') ?? null,
					onFirstFrame: () => (painted = true)
				});
			} catch {
				/* canvas unavailable — the plain surface is the fallback */
			}
		};
		if ('requestIdleCallback' in window) requestIdleCallback(boot, { timeout: 1200 });
		else setTimeout(boot, 250);

		return () => {
			cancelled = true;
			handle?.destroy();
		};
	});
</script>

<div
	bind:this={host}
	class="chat-backdrop pointer-events-none absolute inset-0 overflow-hidden"
	aria-hidden="true"
	data-chat-backdrop
>
	<span bind:this={toneProbes[0]} class="hidden text-accent-1"></span>
	<span bind:this={toneProbes[1]} class="chat-backdrop__light hidden"></span>
	<span bind:this={toneProbes[2]} class="chat-backdrop__deep hidden"></span>
	<span bind:this={lineProbe} class="hidden text-fg-1"></span>
	<canvas bind:this={canvas} class="chat-backdrop__canvas mask-fade-radial" class:chat-backdrop__canvas--painted={painted}
	></canvas>
</div>

<style>
	.chat-backdrop__canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 0.9s ease-out;
	}
	/* Shades of the theme's accent, so every theme gets its own palette: one lighter and turned a
	   little warmer, one deeper and turned a little cooler. Without relative colour support both
	   fall back to Accent 2. */
	.chat-backdrop__light {
		color: var(--color-accent-2);
		color: oklch(from var(--color-accent-1) calc(l + 0.1) calc(c * 0.75) calc(h + 24));
	}
	.chat-backdrop__deep {
		color: var(--color-accent-2);
		color: oklch(from var(--color-accent-1) calc(l - 0.08) c calc(h - 24));
	}
	.chat-backdrop__canvas--painted {
		opacity: 0.85;
	}
</style>

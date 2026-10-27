<script lang="ts">
	import { onMount } from 'svelte';
	import { createAlphaHeroGridField, type AlphaHeroGridHandle } from '../../alpha-hero-grid-field';

	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let painted = $state(false);

	onMount(() => {
		if (!host || !canvas) return;
		const hostEl = host;
		const canvasEl = canvas;

		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			// Still show the static grid field
		}

		let handle: AlphaHeroGridHandle | null = null;
		let cancelled = false;

		const boot = () => {
			try {
				handle = createAlphaHeroGridField({
					canvas: canvasEl,
					host: hostEl,
					onFirstFrame: () => {
						painted = true;
					}
				});
			} catch {
				return;
			}
			if (cancelled) {
				handle.destroy();
				handle = null;
			}
		};

		if ('requestIdleCallback' in window) {
			requestIdleCallback(boot, { timeout: 1500 });
		} else {
			setTimeout(boot, 300);
		}

		return () => {
			cancelled = true;
			handle?.destroy();
		};
	});
</script>

<div class="alpha-hero-backdrop" bind:this={host}>
	<canvas
		bind:this={canvas}
		class="alpha-hero-backdrop__canvas"
		class:alpha-hero-backdrop__canvas--painted={painted}
		aria-hidden="true"
	></canvas>
</div>

<style>
	.alpha-hero-backdrop {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
		background: var(--paper);
	}

	.alpha-hero-backdrop__canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 0.8s ease-out;
		-webkit-mask-image: linear-gradient(180deg, #000 0%, #000 82%, transparent 100%);
		mask-image: linear-gradient(180deg, #000 0%, #000 82%, transparent 100%);
	}

	.alpha-hero-backdrop__canvas--painted {
		opacity: 1;
	}
</style>

<!--
  @component
  The bold hero's backdrop: the brand's octagon dot grid, faint on navy, with slow bands of colour
  drifting through it in the three tones. Near the pointer the dots swell into octagon tiles. The
  centre top stays quiet so the headline reads. Under reduced motion it paints one still frame; it
  stops drawing while off screen or in a hidden tab.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';
	import { octagonPath } from '../../canvas-shapes';

	/** `hero` keeps the headline area calm and fades the bottom; `open` fills the whole ground. */
	let { mask = 'hero' }: { mask?: 'hero' | 'open' } = $props();

	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();
	let painted = $state(false);

	const CELL = 26;
	const FRAME_MS = 1000 / 30;

	const smoothstep = (a: number, b: number, v: number) => {
		const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
		return t * t * (3 - 2 * t);
	};

	onMount(() => {
		if (!host || !canvas) return;
		const hostEl = host;
		const canvasEl = canvas;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		const styles = getComputedStyle(hostEl);
		const tones = [
			styles.getPropertyValue('--bold-sky').trim() || '#84cdf5',
			styles.getPropertyValue('--bold-coral').trim() || '#e9897b',
			styles.getPropertyValue('--bright-pink').trim() || '#ffa3ff'
		];
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		let width = 0;
		let height = 0;
		let pointer: { x: number; y: number } | null = null;
		let visible = true;
		let raf = 0;
		let last = 0;

		function resize() {
			const rect = hostEl.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			width = rect.width;
			height = rect.height;
			canvasEl.width = Math.round(width * dpr);
			canvasEl.height = Math.round(height * dpr);
			ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
		}

		function draw(t: number) {
			ctx!.clearRect(0, 0, width, height);
			const cols = Math.ceil(width / CELL) + 1;
			const rows = Math.ceil(height / CELL) + 1;

			// Every resting dot first, in one path.
			ctx!.globalAlpha = 0.07;
			ctx!.fillStyle = '#ffffff';
			ctx!.beginPath();
			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++)
					octagonPath(ctx!, i * CELL + CELL / 2, j * CELL + CELL / 2, 1.8);
			}
			ctx!.fill();

			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++) {
					const x = i * CELL + CELL / 2;
					const y = j * CELL + CELL / 2;
					const wave =
						0.5 +
						0.32 * Math.sin(x * 0.0105 + t * 0.00031) * Math.cos(y * 0.0125 - t * 0.00023) +
						0.18 * Math.sin((x + y) * 0.0052 + t * 0.00017);
					let glow = smoothstep(0.66, 0.96, wave);
					let reach = 0;
					if (pointer) {
						const d = Math.hypot(x - pointer.x, y - pointer.y);
						reach = Math.max(0, 1 - d / 170) ** 2;
						glow = Math.max(glow, reach);
					}
					if (glow < 0.02) continue;
					const band = Math.sin(x * 0.0019 + t * 0.00004) + Math.cos(y * 0.0024 - t * 0.00003) + 2;
					ctx!.fillStyle = tones[Math.min(2, Math.floor(band * 0.75))];
					ctx!.globalAlpha = 0.1 + glow * 0.4;
					ctx!.beginPath();
					octagonPath(ctx!, x, y, 1.8 + glow * 3.4 + reach * 6.6);
					ctx!.fill();
				}
			}
			ctx!.globalAlpha = 1;
		}

		function frame(now: number) {
			raf = requestAnimationFrame(frame);
			if (!visible || document.hidden || now - last < FRAME_MS) return;
			last = now;
			draw(now);
		}

		resize();
		draw(4000);
		painted = true;

		const resizeObserver = new ResizeObserver(() => {
			resize();
			if (still) draw(4000);
		});
		resizeObserver.observe(hostEl);
		if (still) return () => resizeObserver.disconnect();

		const section = hostEl.parentElement ?? hostEl;
		const onMove = (event: PointerEvent) => {
			const rect = hostEl.getBoundingClientRect();
			pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		};
		const offMove = on(section, 'pointermove', onMove);
		const offLeave = on(section, 'pointerleave', () => (pointer = null));

		const intersection = new IntersectionObserver(([entry]) => {
			visible = entry?.isIntersecting ?? true;
		});
		intersection.observe(hostEl);
		raf = requestAnimationFrame(frame);

		return () => {
			cancelAnimationFrame(raf);
			resizeObserver.disconnect();
			intersection.disconnect();
			offMove();
			offLeave();
		};
	});
</script>

<div class="pattern-field" bind:this={host} aria-hidden="true">
	<canvas bind:this={canvas} class:painted class:open={mask === 'open'}></canvas>
</div>

<style>
	.pattern-field {
		position: absolute;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		pointer-events: none;
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 1s ease-out;
		/* Calm behind the headline, fading out before the bottom edge. */
		-webkit-mask-image:
			radial-gradient(ellipse 46% 30% at 50% 24%, transparent 0%, #000 100%),
			linear-gradient(180deg, #000 70%, transparent 100%);
		mask-image:
			radial-gradient(ellipse 46% 30% at 50% 24%, transparent 0%, #000 100%),
			linear-gradient(180deg, #000 70%, transparent 100%);
		-webkit-mask-composite: source-in;
		mask-composite: intersect;
	}

	canvas.painted {
		opacity: 1;
	}

	canvas.open {
		-webkit-mask-image: none;
		mask-image: none;
	}
</style>

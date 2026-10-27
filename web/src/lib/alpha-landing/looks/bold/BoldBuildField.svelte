<!--
  @component
  The closing section's backdrop: pieces of the brand's three patterns drop in and stack into a
  rising heap — everyone bringing a piece — hold, clear from the top, and build again. Wide screens
  build on the right of the text; narrow ones along the bottom. The rest of the ground is the faint
  octagon grid. Pieces near the pointer lift. Decorative; one still (built) frame under reduced
  motion; no drawing while off screen.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';

	let host = $state<HTMLDivElement>();
	let canvas = $state<HTMLCanvasElement>();

	const CELL = 22;
	const FRAME_MS = 1000 / 30;
	const PERIOD = 11000;

	type Piece = { i: number; j: number; tone: number; kind: number; order: number; top: number };

	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	const easeOutBack = (v: number) => 1 + 2.4 * (v - 1) ** 3 + 1.4 * (v - 1) ** 2;
	const hash = (a: number, b: number) => {
		const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
		return x - Math.floor(x);
	};

	function octagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
		const c = r * 0.55;
		ctx.beginPath();
		ctx.moveTo(x - r + c, y - r);
		ctx.lineTo(x + r - c, y - r);
		ctx.lineTo(x + r, y - r + c);
		ctx.lineTo(x + r, y + r - c);
		ctx.lineTo(x + r - c, y + r);
		ctx.lineTo(x - r + c, y + r);
		ctx.lineTo(x - r, y + r - c);
		ctx.lineTo(x - r, y - r + c);
		ctx.closePath();
		ctx.fill();
	}

	onMount(() => {
		if (!host || !canvas) return;
		const hostEl = host;
		const canvasEl = canvas;
		const context = canvasEl.getContext('2d');
		if (!context) return;
		const ctx = context;

		const css = getComputedStyle(hostEl);
		const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		const ink = read('--dark-blue', '#142e3e');
		const tones = [
			read('--bold-coral', '#e9897b'),
			read('--bright-pink', '#ffa3ff'),
			read('--bold-sky', '#84c4ee')
		];
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		let width = 0;
		let height = 0;
		let cols = 0;
		let rows = 0;
		let pieces: Piece[] = [];
		let pointer: { x: number; y: number } | null = null;

		function layout() {
			pieces = [];
			const wide = width >= 1024;
			const x0 = wide ? Math.floor(cols * 0.6) : 1;
			const x1 = cols - 2;
			const maxH = wide ? rows - 3 : Math.max(3, Math.floor(rows * 0.26));
			const minH = wide ? 3 : 2;
			const span = Math.max(1, x1 - x0);
			for (let i = x0; i <= x1; i++) {
				const t = (i - x0) / span;
				const rise = wide ? t : 0.5 + 0.5 * Math.sin(t * Math.PI * 2.2);
				const h = Math.round(minH + (maxH - minH) * rise * (0.75 + 0.25 * hash(i, 7)));
				for (let k = 0; k < h; k++) {
					const j = rows - 1 - k;
					// Pieces come in 3 x 3 patches, each patch one pattern in one tone.
					const pi = Math.floor(i / 3);
					const pj = Math.floor(j / 3);
					pieces.push({
						i,
						j,
						tone: Math.floor(hash(pi, pj) * 3),
						kind: Math.floor(hash(pj + 5, pi + 9) * 3),
						order: (k / maxH) * 0.75 + ((i - x0) / span) * 0.15 + hash(i, j) * 0.1,
						top: (h - 1 - k) / Math.max(1, maxH)
					});
				}
			}
		}

		function resize() {
			const rect = hostEl.getBoundingClientRect();
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			width = rect.width;
			height = rect.height;
			canvasEl.width = Math.round(width * dpr);
			canvasEl.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cols = Math.ceil(width / CELL);
			rows = Math.ceil(height / CELL);
			layout();
		}

		function piece(p: Piece, x: number, y: number, scale: number) {
			const half = (CELL / 2) * scale;
			const tone = tones[p.tone];
			if (p.kind === 0) {
				// ink dots on the tone
				ctx.fillStyle = tone;
				ctx.fillRect(x - half, y - half, half * 2, half * 2);
				ctx.fillStyle = ink;
				octagon(ctx, x, y, half * 0.46);
			} else {
				// tone tiles on ink, or tone dots on ink
				ctx.fillStyle = ink;
				ctx.fillRect(x - half, y - half, half * 2, half * 2);
				ctx.fillStyle = tone;
				octagon(ctx, x, y, p.kind === 1 ? half : half * 0.46);
			}
		}

		function draw(t: number) {
			ctx.clearRect(0, 0, width, height);
			ctx.fillStyle = '#ffffff';
			ctx.globalAlpha = 0.07;
			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++) octagon(ctx, i * CELL + CELL / 2, j * CELL + CELL / 2, 1.8);
			}
			ctx.globalAlpha = 1;

			const local = t % PERIOD;
			for (const p of pieces) {
				const x = p.i * CELL + CELL / 2;
				const y = p.j * CELL + CELL / 2;
				const arrive = clamp01((local / 4600 - p.order) * 7);
				const leave = clamp01(((local - 8200) / 2200 - p.top * 0.85) * 6);
				if (arrive <= 0 || leave >= 1) continue;
				const drop = (1 - easeOutBack(arrive)) * -CELL * 2.5;
				let scale = Math.min(1, 0.6 + arrive * 0.4) * (1 - leave);
				let lift = 0;
				if (pointer) {
					const near = Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / 130);
					lift = -near * near * 6;
					scale *= 1 + near * 0.08;
				}
				ctx.globalAlpha = Math.min(1, arrive * 1.5) * (1 - leave * 0.6);
				piece(p, x, y + drop + lift, scale * 0.94);
			}
			ctx.globalAlpha = 1;
		}

		resize();
		draw(6500);

		const resizeObserver = new ResizeObserver(() => {
			resize();
			draw(6500);
		});
		resizeObserver.observe(hostEl);
		if (still) return () => resizeObserver.disconnect();

		let visible = true;
		let raf = 0;
		let last = 0;
		const started = performance.now();
		const frame = (now: number) => {
			raf = requestAnimationFrame(frame);
			if (!visible || document.hidden || now - last < FRAME_MS) return;
			last = now;
			draw(Math.max(0, now - started));
		};

		const section = hostEl.parentElement ?? hostEl;
		const offMove = on(section, 'pointermove', (event: PointerEvent) => {
			const rect = hostEl.getBoundingClientRect();
			pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		});
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

<div class="build-field" bind:this={host} aria-hidden="true">
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	.build-field {
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
	}
</style>

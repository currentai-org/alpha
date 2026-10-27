<!--
  @component
  A live tile of the brand's octagon grid that acts out one of Alpha's ideas:

  - `language`  the dots swell into tiles to write one character at a time, script after script
  - `data`      tiles pile up like stored data, then a sweep forgets them all and the grid refills
  - `rules`     a brush repaints the grid in a new style or colour on every pass (pointer drives it)
  - `xray`      a lens drifts over the dots and shows the structure underneath (pointer drives it)

  Decorative: hidden from assistive tech. Paints one still frame under reduced motion and stops
  drawing while off screen.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { on } from 'svelte/events';

	let {
		concept,
		cell = 16
	}: {
		concept: 'language' | 'data' | 'rules' | 'xray';
		/** Grid pitch in CSS px; small values make a badge-sized glyph. */
		cell?: number;
	} = $props();

	let host = $state<HTMLSpanElement>();
	let canvas = $state<HTMLCanvasElement>();

	const FRAME_MS = 1000 / 30;
	const GLYPHS = ['A', 'あ', 'ع', 'Ж', 'अ', '한', 'ñ', 'Ω'];
	const LANGUAGES = [
		'ENGLISH',
		'JAPANESE',
		'ARABIC',
		'RUSSIAN',
		'HINDI',
		'KOREAN',
		'SPANISH',
		'GREEK'
	];

	const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
	const smooth = (a: number, b: number, v: number) => {
		const t = clamp01((v - a) / (b - a));
		return t * t * (3 - 2 * t);
	};
	const easeOutBack = (v: number) => {
		const c = 1.6;
		return 1 + (c + 1) * (v - 1) ** 3 + c * (v - 1) ** 2;
	};

	// The pattern sheet's octagon: half-width r, corners cut at 0.55 r. At r = CELL / 2 the shapes
	// touch and the ink between them reads as diamonds, the sheet's tile pattern.
	function octagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
		if (r <= 0.15) return;
		// Below ~3px across the corners don't render; a square stays crisp at badge size.
		if (r < 1.6) {
			ctx.fillRect(x - r, y - r, r * 2, r * 2);
			return;
		}
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
		const CELL = cell;

		const css = getComputedStyle(hostEl);
		const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
		const ink = read('--dark-blue', '#142e3e');
		const sky = read('--bold-sky', '#84c4ee');
		const coral = read('--bold-coral', '#e9897b');
		const pink = read('--bright-pink', '#ffa3ff');
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

		let width = 0;
		let height = 0;
		let cols = 0;
		let rows = 0;
		let ox = 0;
		let oy = 0;
		let masks: Float32Array[] = [];
		let jitter = new Float32Array(0);
		let pointer: { x: number; y: number } | null = null;
		let lens = { x: 0, y: 0 };

		const cx = (i: number) => ox + i * CELL + CELL / 2;
		const cy = (j: number) => oy + j * CELL + CELL / 2;

		function glyphMasks() {
			const scale = 4;
			const off = document.createElement('canvas');
			off.width = cols * scale;
			off.height = rows * scale;
			const g = off.getContext('2d', { willReadFrequently: true });
			if (!g) return [];
			return GLYPHS.map((glyph) => {
				g.clearRect(0, 0, off.width, off.height);
				g.fillStyle = '#000';
				// Fit each glyph's ink box to 80% of the grid and centre it, whatever the script's metrics.
				const family = `"Noto Serif", "Hiragino Sans", "Apple SD Gothic Neo", "Noto Sans", serif`;
				g.font = `600 100px ${family}`;
				const m = g.measureText(glyph);
				const inkW = m.actualBoundingBoxLeft + m.actualBoundingBoxRight || 60;
				const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent || 70;
				const fit = Math.min((off.width * 0.8) / inkW, (off.height * 0.8) / inkH);
				g.font = `600 ${100 * fit}px ${family}`;
				g.textAlign = 'left';
				g.textBaseline = 'alphabetic';
				g.fillText(
					glyph,
					off.width / 2 - ((m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2) * fit,
					off.height / 2 + ((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2) * fit
				);
				const pixels = g.getImageData(0, 0, off.width, off.height).data;
				const mask = new Float32Array(cols * rows);
				for (let j = 0; j < rows; j++) {
					for (let i = 0; i < cols; i++) {
						let sum = 0;
						for (let y = 0; y < scale; y++) {
							for (let x = 0; x < scale; x++) {
								sum += pixels[((j * scale + y) * off.width + i * scale + x) * 4 + 3];
							}
						}
						mask[j * cols + i] = sum / (scale * scale * 255);
					}
				}
				return mask;
			});
		}

		function resize() {
			const rect = hostEl.getBoundingClientRect();
			// Badge-sized glyphs render at 3x at least, so their 2px cells stay sharp.
			const dpr =
				rect.width < 64
					? Math.max(window.devicePixelRatio || 1, 3)
					: Math.min(window.devicePixelRatio || 1, 2);
			width = rect.width;
			height = rect.height;
			canvasEl.width = Math.round(width * dpr);
			canvasEl.height = Math.round(height * dpr);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			cols = Math.max(1, Math.floor(width / CELL));
			rows = Math.max(1, Math.floor(height / CELL));
			ox = (width - cols * CELL) / 2;
			oy = (height - rows * CELL) / 2;
			jitter = new Float32Array(cols * rows).map(
				(_, k) => (((Math.sin(k * 12.9898) * 43758.5453) % 1) + 1) % 1
			);
			if (concept === 'language') masks = glyphMasks();
			lens = { x: width * 0.5, y: height * 0.5 };
		}

		function fill(color: string) {
			ctx.fillStyle = color;
			ctx.fillRect(0, 0, width, height);
		}

		// Morphs between two glyph masks, rippling across from the left.
		function drawMasks(from: Float32Array, to: Float32Array, p: number) {
			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++) {
					const k = j * cols + i;
					const local = smooth(0, 1, p * 1.7 - (i / cols) * 0.7);
					const cover = from[k] + (to[k] - from[k]) * local;
					const r = CELL * (0.22 + 0.28 * smooth(0.2, 0.7, cover));
					octagon(ctx, cx(i), cy(j), r);
				}
			}
		}

		// The language a glyph is written in, named in a corner on the full-size card.
		function languageLabel(index: number) {
			if (CELL < 8) return;
			const label = LANGUAGES[index];
			ctx.font = '500 10px "DM Mono", ui-monospace, monospace';
			const w = ctx.measureText(label).width + 12;
			ctx.fillStyle = ink;
			ctx.fillRect(width - w - 8, height - 26, w, 18);
			ctx.fillStyle = sky;
			ctx.textBaseline = 'middle';
			ctx.fillText(label, width - w - 2, height - 17);
		}

		// One character at a time. Under the pointer the card becomes a dial: moving across it
		// scrubs through the scripts, and leaving picks the cycle up from the one it shows.
		const hold = 1900;
		const morph = 800;
		const period = hold + morph;
		let languageOffset = 0;
		let scrub = { from: 0, to: 0, at: -1e9 };
		let scrubbing = false;
		function drawLanguage(t: number) {
			fill(sky);
			ctx.fillStyle = ink;
			if (!masks.length) return;
			const n = masks.length;
			if (pointer) {
				const target = Math.min(n - 1, Math.floor((pointer.x / width) * n));
				if (!scrubbing) {
					const shown = Math.floor((t + languageOffset) / period) % n;
					scrub = { from: shown, to: shown, at: -1e9 };
					scrubbing = true;
				}
				if (target !== scrub.to) scrub = { from: scrub.to, to: target, at: t };
				const p = clamp01((t - scrub.at) / 420);
				drawMasks(masks[scrub.from], masks[scrub.to], p);
				languageLabel(p < 0.5 ? scrub.from : scrub.to);
				return;
			}
			if (scrubbing) {
				// Resume the cycle on the glyph the pointer left, at the start of its hold.
				scrubbing = false;
				languageOffset = scrub.to * period - t + n * period * 1000;
			}
			const step = Math.floor((t + languageOffset) / period);
			const p = clamp01((((t + languageOffset) % period) - hold) / morph);
			drawMasks(masks[step % n], masks[(step + 1) % n], p);
			languageLabel(p < 0.5 ? step % n : (step + 1) % n);
		}

		// Data arrives tile by tile, sits, and is wiped away on a diagonal; faint slots stay behind.
		// Under the pointer the grid fills and the pointer becomes an eraser: tiles it passes over
		// shrink away and grow back a moment later.
		const dataPeriod = 7600;
		let dataOffset = 0;
		let hoverStart = -1;
		let erasedAt = new Float32Array(0);
		function eraseAround(t: number) {
			if (!pointer) return;
			if (erasedAt.length !== cols * rows) erasedAt = new Float32Array(cols * rows);
			const radius = CELL * 1.7;
			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++) {
					const k = j * cols + i;
					if (Math.hypot(cx(i) - pointer.x, cy(j) - pointer.y) > radius) continue;
					if (erasedAt[k] === 0 || t - erasedAt[k] > 1900) erasedAt[k] = t || 1;
				}
			}
		}
		function eraserSize(k: number, t: number) {
			const at = erasedAt[k];
			if (!at) return 1;
			const dt = t - at;
			if (dt < 160) return 1 - dt / 160;
			if (dt < 1300) return 0;
			if (dt < 1750) return easeOutBack((dt - 1300) / 450);
			erasedAt[k] = 0;
			return 1;
		}
		function drawData(t: number) {
			fill(ink);
			if (pointer && hoverStart < 0) hoverStart = t;
			if (!pointer && hoverStart >= 0) {
				// Back to the cycle at the moment the grid is full.
				hoverStart = -1;
				erasedAt.fill(0);
				dataOffset = 2600 - (t % dataPeriod) + dataPeriod;
			}
			eraseAround(t);
			const local = (t + dataOffset) % dataPeriod;
			for (let j = 0; j < rows; j++) {
				for (let i = 0; i < cols; i++) {
					const k = j * cols + i;
					const x = cx(i);
					const y = cy(j);
					ctx.fillStyle = coral;
					ctx.globalAlpha = 0.28;
					octagon(ctx, x, y, Math.max(CELL * 0.12, Math.min(0.6, CELL * 0.3)));
					ctx.globalAlpha = 1;
					const order = (k / (cols * rows)) * 0.8 + jitter[k] * 0.2;
					let size: number;
					if (hoverStart >= 0) {
						const cycle =
							Math.max(0, easeOutBack(clamp01((local / 2300 - order) * 5))) *
							(1 - smooth(0, 1, ((local - 4000) / 1300 - (cols - 1 - i + j) / (cols + rows)) * 4));
						const fillIn = easeOutBack(clamp01(((t - hoverStart) / 500 - order * 0.6) * 4));
						size = Math.max(cycle, fillIn) * (erasedAt.length ? eraserSize(k, t) : 1);
					} else {
						const grow = easeOutBack(clamp01((local / 2300 - order) * 5));
						const sweep = (cols - 1 - i + j) / (cols + rows);
						const gone = smooth(0, 1, ((local - 4000) / 1300 - sweep) * 4);
						size = Math.max(0, grow) * (1 - gone);
					}
					if (size <= 0.01) continue;
					octagon(ctx, x, y, CELL * 0.5 * Math.min(size, 1.08));
				}
			}
		}

		// Settings, made visible: four colourways x three shapes. A change spreads from where it
		// was made as a ripple, the way a tapped theme swatch repaints an app. On its own the card
		// taps random spots; under the pointer, left-right picks the colourway, up-down the shape,
		// and every change ripples out from the pointer.
		const PALETTES = [
			{ bg: pink, fg: ink },
			{ bg: ink, fg: pink },
			{ bg: sky, fg: ink },
			{ bg: ink, fg: coral }
		];
		const SHAPES = [0.22, 0.36, 0.5];
		type Style = { palette: number; shape: number };
		type Ripple = { x: number; y: number; at: number; style: Style };
		const AUTO = [
			{ palette: 1, shape: 2 },
			{ palette: 2, shape: 1 },
			{ palette: 3, shape: 0 },
			{ palette: 0, shape: 1 },
			{ palette: 2, shape: 2 },
			{ palette: 0, shape: 0 }
		];
		let base: Style = { palette: 0, shape: 0 };
		let ripples: Ripple[] = [];
		let autoStep = 0;
		let lastAuto = 0;
		const same = (a: Style, b: Style) => a.palette === b.palette && a.shape === b.shape;
		const latest = () => ripples.at(-1)?.style ?? base;

		function drawRules(t: number) {
			const speed = Math.max(width, height) * 1.25; // px per second
			const band = CELL * 2.2;
			const reach = Math.hypot(width, height) + band;

			if (pointer) {
				const want = {
					palette: Math.min(3, Math.floor((pointer.x / width) * 4)),
					shape: Math.min(2, Math.floor((pointer.y / height) * 3))
				};
				if (!same(want, latest())) ripples.push({ x: pointer.x, y: pointer.y, at: t, style: want });
				lastAuto = t;
			} else if (t - lastAuto > 2400) {
				lastAuto = t;
				autoStep = (autoStep + 1) % AUTO.length;
				ripples.push({
					x: width * (0.2 + 0.6 * jitter[(autoStep * 7) % jitter.length]),
					y: height * (0.2 + 0.6 * jitter[(autoStep * 13 + 3) % jitter.length]),
					at: t,
					style: AUTO[autoStep]
				});
			}
			// A ripple that has crossed the whole card becomes the ground.
			while (ripples.length && ((t - ripples[0].at) / 1000) * speed > reach) {
				base = ripples.shift()!.style;
			}

			// One cell of bleed on every side, so the card's edges change with the wave too.
			for (let j = -1; j <= rows; j++) {
				for (let i = -1; i <= cols; i++) {
					const x = cx(i);
					const y = cy(j);
					// The newest ripple to reach this cell decides it; mid-front it is changing from
					// what the ripples before it left.
					let from = base;
					let to = base;
					let k = 1;
					for (const ripple of ripples) {
						const front = ((t - ripple.at) / 1000) * speed;
						const kk = clamp01((front - Math.hypot(x - ripple.x, y - ripple.y)) / band);
						if (kk <= 0) continue;
						from = k >= 0.5 ? to : from;
						to = ripple.style;
						k = kk;
					}
					// The colour changes the moment the front arrives; the shape morphs through the band.
					const style = to;
					const r = k < 0.5 ? SHAPES[from.shape] * (1 - 2 * k) : SHAPES[to.shape] * (2 * k - 1);
					ctx.fillStyle = PALETTES[style.palette].bg;
					ctx.fillRect(x - CELL / 2, y - CELL / 2, CELL + 0.5, CELL + 0.5);
					ctx.fillStyle = PALETTES[style.palette].fg;
					octagon(ctx, x, y, CELL * r);
				}
			}
			settingsReadout(latest());
		}

		// A tiny settings panel in the corner of the full-size card: the four colourways and the
		// three shapes, with the current choice marked.
		function settingsReadout(style: Style) {
			if (CELL < 8) return;
			const sw = 12;
			const gap = 4;
			const pad = 6;
			const w = pad * 2 + 4 * sw + 3 * gap + 10 + 3 * sw + 2 * gap;
			const h = pad * 2 + sw;
			const x0 = 8;
			const y0 = height - h - 8;
			ctx.fillStyle = ink;
			ctx.fillRect(x0, y0, w, h);
			PALETTES.forEach((palette, index) => {
				const x = x0 + pad + index * (sw + gap);
				ctx.fillStyle = palette.bg;
				ctx.fillRect(x, y0 + pad, sw, sw);
				ctx.fillStyle = palette.fg;
				octagon(ctx, x + sw / 2, y0 + pad + sw / 2, sw * 0.22);
				if (index === style.palette) {
					ctx.strokeStyle = '#fff';
					ctx.lineWidth = 1.5;
					ctx.strokeRect(x - 1.5, y0 + pad - 1.5, sw + 3, sw + 3);
				}
			});
			SHAPES.forEach((shape, index) => {
				const x = x0 + pad + 4 * (sw + gap) + 10 + index * (sw + gap);
				ctx.fillStyle = index === style.shape ? '#fff' : 'rgba(255,255,255,0.35)';
				octagon(ctx, x + sw / 2, y0 + pad + sw / 2, sw * shape);
			});
		}

		const STEPS = [
			{ y: 0.3, from: 0.14, to: 0.82, color: coral },
			{ y: 0.5, from: 0.14, to: 0.62, color: pink },
			{ y: 0.7, from: 0.14, to: 0.9, color: sky }
		];

		// Faint dots on ink; inside the lens they grow and three hidden rows of steps light up.
		function drawXray(t: number) {
			fill(ink);
			const target = pointer ?? {
				x: width * (0.5 + 0.3 * Math.sin(t * 0.00042)),
				y: height * (0.5 + 0.26 * Math.sin(t * 0.00067 + 1.2))
			};
			lens = still
				? target
				: { x: lens.x + (target.x - lens.x) * 0.12, y: lens.y + (target.y - lens.y) * 0.12 };
			const radius = Math.min(width, height) * 0.34;
			const stepRows = STEPS.map((s) => ({ ...s, row: Math.round(s.y * (rows - 1)) }));
			for (let j = 0; j < rows; j++) {
				const lit = stepRows.find((s) => s.row === j);
				for (let i = 0; i < cols; i++) {
					const x = cx(i);
					const y = cy(j);
					const q = smooth(radius, radius * 0.72, Math.hypot(x - lens.x, y - lens.y));
					const u = i / Math.max(1, cols - 1);
					const structure = lit && u >= lit.from && u <= lit.to;
					if (structure && q > 0.01) {
						ctx.fillStyle = lit.color;
						ctx.globalAlpha = 0.35 + 0.65 * q;
						octagon(ctx, x, y, CELL * (0.2 + 0.3 * q));
					} else {
						ctx.fillStyle = sky;
						ctx.globalAlpha = 0.4 + 0.5 * q;
						octagon(ctx, x, y, CELL * (0.18 + 0.1 * q));
					}
				}
			}
			ctx.globalAlpha = 0.7;
			ctx.strokeStyle = sky;
			ctx.lineWidth = Math.max(1, CELL / 10);
			ctx.beginPath();
			ctx.arc(lens.x, lens.y, radius, 0, Math.PI * 2);
			ctx.stroke();
			ctx.globalAlpha = 1;
		}

		const draw = { language: drawLanguage, data: drawData, rules: drawRules, xray: drawXray }[
			concept
		];
		const restingFrame = { language: 0, data: 3200, rules: 0, xray: 0 }[concept];

		resize();
		draw(restingFrame);

		const resizeObserver = new ResizeObserver(() => {
			resize();
			draw(restingFrame);
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

		const card = hostEl.closest('a') ?? hostEl;
		const offMove = on(card, 'pointermove', (event: PointerEvent) => {
			const rect = hostEl.getBoundingClientRect();
			pointer = {
				x: Math.min(width, Math.max(0, event.clientX - rect.left)),
				y: Math.min(height, Math.max(0, event.clientY - rect.top))
			};
		});
		const offLeave = on(card, 'pointerleave', () => (pointer = null));
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

<span class="pattern-glyph" bind:this={host} aria-hidden="true">
	<canvas bind:this={canvas}></canvas>
</span>

<style>
	.pattern-glyph {
		position: absolute;
		inset: 0;
		overflow: hidden;
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>

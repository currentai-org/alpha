/**
 * Potluck field — the Bold /alpha page's two backdrops as one.
 *
 * The ground is the hero's octagon dot grid, with slow bands of colour drifting through it
 * (`BoldPatternField`). Every so often, where a band is brightest, the colour gathers: the dots around
 * one spot warm up in its tone and pieces of the brand's three patterns drop in and stack into a small
 * heap, the closing section's "everyone brings a piece" (`BoldBuildField`), in miniature. The heap
 * holds, clears from the top, and the colour drifts on.
 *
 * It plays along with the pointer. Dots near it swell into tiles, and moving it leaves a fading
 * trail of colour that steps through the three tones as it travels. Heaps lift as it passes. A
 * click on open ground sends a ripple out through the grid and gathers a quick heap on the spot; a
 * click on a heap knocks it over, its pieces tumbling away.
 *
 * Made for the new-chat screen: transparent, theme-aware (the caller hands in resolved token colours),
 * slow and dim on its own, at most two heaps of its own at a time, none under the excluded element
 * (the greeting and composer), where pointer effects are damped and clicks are left alone. Plain
 * canvas 2D; pauses while off screen or in a hidden tab; one still frame with a single built heap and
 * no pointer play under reduced motion.
 */

import { on } from 'svelte/events';
import { clamp01, easeOutBack, octagonPath, smoothstep } from './canvas-shapes';

/** Resolved CSS colours (any syntax the canvas accepts, e.g. `oklch(…)`). */
type PotluckFieldPalette = { tones: readonly [string, string, string]; line: string };

export type PotluckFieldOptions = {
	canvas: HTMLCanvasElement;
	host: HTMLElement;
	/** Theme colours, re-read about once a second so a theme or mode switch follows live. */
	palette: () => PotluckFieldPalette;
	/** The element heaps keep clear of, and under which the drift is damped. */
	exclude?: () => HTMLElement | null;
	/**
	 * The element whose pointer events drive the play (the canvas itself takes none, so the page
	 * under it stays clickable). Omitted → no pointer play.
	 */
	pointerTarget?: HTMLElement;
	onFirstFrame?: () => void;
};

export type PotluckFieldHandle = { destroy: () => void };

export type Rect = { left: number; top: number; right: number; bottom: number };

type Piece = { i: number; j: number; kind: number; tone: number; order: number; top: number };

type Heap = {
	/** Cell bounds, for spacing and the glow centre. */
	box: Rect;
	cx: number;
	cy: number;
	tone: number;
	pieces: Piece[];
	born: number;
	buildMs: number;
	holdMs: number;
};

type Ripple = { x: number; y: number; born: number; tone: number };

/** A piece knocked loose from a heap, tumbling under gravity. */
type Flyer = {
	piece: Piece;
	x: number;
	y: number;
	vx: number;
	vy: number;
	spin: number;
	vspin: number;
	born: number;
};

const FRAME_MS = 1000 / 30;
/** Clock step cap, so a backgrounded tab resumes where it left off instead of jumping. */
const MAX_DT = 50;
const DOT_R = 1.6;
const DOT_ALPHA = 0.08;
/** Drift glow: alpha and extra dot radius at the crest of a band. */
const GLOW_ALPHA = 0.26;
const GLOW_GROW = 2.4;
/** The hero's wave, slowed for a screen people sit in front of. */
const DRIFT = 0.6;
const MAX_HEAPS = 2;
const BUILD_MS = 4200;
const CLEAR_MS = 2600;
const HOLD_MS: readonly [number, number] = [7000, 10000];
const REST_MS: readonly [number, number] = [1800, 4200];
const FIRST_HEAP_MS = 700;
const PIECE_ALPHA = 0.78;
/** How far, in px, a heap warms the dots around it while it stands. */
const GATHER_REACH = 150;
const EXCLUSION_PAD = 48;
const EXCLUSION_DAMP = 0.2;
const EXCLUSION_REFRESH_FRAMES = 15;
/** Pointer play. */
const HOVER_REACH = 140;
const HOVER_GROW = 4.5;
const TRAIL_RADIUS = 1.6;
const TRAIL_TAU_MS = 900;
/** Pointer travel, in px, before the trail moves on to the next tone. */
const TRAIL_TONE_STEP = 240;
const LIFT_REACH = 120;
const RIPPLE_SPEED = 0.42;
const RIPPLE_MS = 1500;
const RIPPLE_WIDTH = 34;
const CLICK_BUILD_MS = 1500;
const CLICK_HOLD_MS: readonly [number, number] = [4500, 6500];
/** Heaps standing at once, the field's own plus the ones clicks gathered. */
const MAX_ALL_HEAPS = 6;
const FLYER_MS = 1500;
const GRAVITY = 0.0016;
/** Clicks on these stay with the page. */
const CONTROLS =
	'a, button, input, textarea, select, label, summary, [role="button"], [role="menuitem"], [contenteditable], [data-backdrop-exclude]';
/**
 * Where heaps may stand: inside this share of `mask-fade-radial`'s ellipse (75% × 70% at 50% 45%),
 * which keeps them out of the faded corners.
 */
const VISIBLE_REACH = 0.62;

const between = (range: readonly [number, number], r: number) =>
	range[0] + (range[1] - range[0]) * r;

const cellSizeFor = (width: number) => (width < 640 ? 16 : width < 1100 ? 18 : 20);

/** The hero's drifting bands: ~0.5 on average, crests near 1. */
export function wave(x: number, y: number, t: number) {
	const s = t * DRIFT;
	return (
		0.5 +
		0.32 * Math.sin(x * 0.0105 + s * 0.00031) * Math.cos(y * 0.0125 - s * 0.00023) +
		0.18 * Math.sin((x + y) * 0.0052 + s * 0.00017)
	);
}

/** Which of the three tones a band paints at (x, y). */
function bandTone(x: number, y: number, t: number) {
	const s = t * DRIFT;
	const band = Math.sin(x * 0.0019 + s * 0.00004) + Math.cos(y * 0.0024 - s * 0.00003) + 2;
	return Math.min(2, Math.floor(band * 0.75));
}

const overlaps = (a: Rect, b: Rect) =>
	a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Column heights of a small hill-shaped heap, `width` columns wide and at most `peak` tall. `rand`
 * returns values in [0, 1).
 */
export function heapHeights(width: number, peak: number, rand: () => number): number[] {
	return Array.from({ length: width }, (_, k) => {
		const hill = Math.sin((Math.PI * (k + 0.5)) / width);
		return Math.max(1, Math.round(peak * hill * (0.75 + 0.25 * rand())));
	});
}

/**
 * Picks where the next heap stands, in px: the brightest point of the drift among candidates that
 * sit inside the visible part of the field and clear of `blocked` (the excluded element and the
 * heaps already standing). Null when nowhere fits.
 */
export function pickHeapSite(opts: {
	width: number;
	height: number;
	/** The heap's own size in px. */
	size: { w: number; h: number };
	blocked: Rect[];
	t: number;
	rand: () => number;
	tries?: number;
}): { left: number; top: number } | null {
	const { width, height, size, blocked, t, rand, tries = 28 } = opts;
	let best: { left: number; top: number; score: number } | null = null;
	for (let n = 0; n < tries; n++) {
		const left = rand() * (width - size.w);
		const top = rand() * (height - size.h);
		const cx = left + size.w / 2;
		const cy = top + size.h / 2;
		const reach = Math.hypot(
			(cx - width * 0.5) / (width * 0.75),
			(cy - height * 0.45) / (height * 0.7)
		);
		if (reach > VISIBLE_REACH) continue;
		const box = { left, top, right: left + size.w, bottom: top + size.h };
		if (blocked.some((b) => overlaps(box, b))) continue;
		const score = wave(cx, cy, t);
		if (!best || score > best.score) best = { left, top, score };
	}
	return best && { left: best.left, top: best.top };
}

export function createAlphaPotluckField(opts: PotluckFieldOptions): PotluckFieldHandle {
	const { canvas, host, palette, exclude, pointerTarget, onFirstFrame } = opts;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Canvas 2D unavailable');
	const ctx = context;
	const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let width = 0;
	let height = 0;
	let cell = 20;
	let cols = 0;
	let rows = 0;
	let clock = 0;
	let lastNow = 0;
	let lastDraw = 0;
	let lastStep = 0;
	let raf = 0;
	let frames = 0;
	let visible = true;
	let painted = false;
	let nextHeapAt = FIRST_HEAP_MS;
	let exclusion: Rect | null = null;
	let colors = palette();
	const heaps: Heap[] = [];
	const ripples: Ripple[] = [];
	const flyers: Flyer[] = [];
	/** Trail warmth per grid cell, and the tone it was laid down in. */
	let heat = new Float32Array(0);
	let heatTone = new Uint8Array(0);
	let pointer: { x: number; y: number } | null = null;
	let brushTone = 0;
	let travelled = 0;

	const readExclusion = (): Rect | null => {
		const el = exclude?.();
		if (!el) return null;
		const h = host.getBoundingClientRect();
		const r = el.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return null;
		return {
			left: r.left - h.left - EXCLUSION_PAD,
			top: r.top - h.top - EXCLUSION_PAD,
			right: r.right - h.left + EXCLUSION_PAD,
			bottom: r.bottom - h.top + EXCLUSION_PAD
		};
	};

	function resize() {
		const rect = host.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = rect.width;
		height = rect.height;
		canvas.width = Math.round(width * dpr);
		canvas.height = Math.round(height * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		cell = cellSizeFor(width);
		cols = Math.ceil(width / cell) + 1;
		rows = Math.ceil(height / cell) + 1;
		heat = new Float32Array(cols * rows);
		heatTone = new Uint8Array(cols * rows);
		exclusion = readExclusion();
		heaps.length = 0;
		ripples.length = 0;
		flyers.length = 0;
		nextHeapAt = clock + FIRST_HEAP_MS;
	}

	/** Lays out a new heap where the drift is brightest, or returns false when nowhere fits. */
	function spawnHeap(at: number): boolean {
		const narrow = width < 640;
		const w = narrow ? 3 + Math.floor(Math.random() * 2) : 4 + Math.floor(Math.random() * 3);
		const peak = narrow ? 2 + Math.floor(Math.random() * 2) : 3 + Math.floor(Math.random() * 2);
		const heights = heapHeights(w, peak, Math.random);
		const tall = Math.max(...heights);
		const blocked = heaps.map((h) => ({
			left: h.box.left - cell * 3,
			top: h.box.top - cell * 3,
			right: h.box.right + cell * 3,
			bottom: h.box.bottom + cell * 3
		}));
		if (exclusion) blocked.push(exclusion);
		const site = pickHeapSite({
			width,
			height,
			size: { w: w * cell, h: tall * cell },
			blocked,
			t: at,
			rand: Math.random
		});
		if (!site) return false;

		const i0 = Math.round(site.left / cell);
		const base = Math.round((site.top + tall * cell) / cell) - 1;
		const cx = (i0 + w / 2) * cell;
		const cy = (base + 1 - tall / 2) * cell;
		addHeap(i0, base, heights, bandTone(cx, cy, at), at, BUILD_MS, between(HOLD_MS, Math.random()));
		return true;
	}

	/** Gathers a quick heap standing on the clicked point, unless it would cover the greeting. */
	function spawnHeapAt(x: number, y: number, tone: number, at: number) {
		const w = 3 + Math.floor(Math.random() * 2);
		const heights = heapHeights(w, 2 + Math.floor(Math.random() * 2), Math.random);
		const tall = Math.max(...heights);
		let i0 = Math.round(x / cell - w / 2);
		const base = Math.floor(y / cell);
		const box = () => ({
			left: i0 * cell,
			top: (base + 1 - tall) * cell,
			right: (i0 + w) * cell,
			bottom: (base + 1) * cell
		});
		if (exclusion && overlaps(box(), exclusion)) {
			// Slide it sideways off the greeting, toward the side that was clicked.
			const mid = (exclusion.left + exclusion.right) / 2;
			i0 = x < mid ? Math.floor(exclusion.left / cell) - w : Math.ceil(exclusion.right / cell);
			if (i0 < 0 || (i0 + w) * cell > width || overlaps(box(), exclusion)) return;
		}
		while (heaps.length >= MAX_ALL_HEAPS) knockOver(heaps[0], at);
		addHeap(i0, base, heights, tone, at, CLICK_BUILD_MS, between(CLICK_HOLD_MS, Math.random()));
	}

	function addHeap(
		i0: number,
		base: number,
		heights: number[],
		tone: number,
		at: number,
		buildMs: number,
		holdMs: number
	) {
		const w = heights.length;
		const tall = Math.max(...heights);
		const cx = (i0 + w / 2) * cell;
		const cy = (base + 1 - tall / 2) * cell;
		const pieces: Piece[] = [];
		heights.forEach((h, k) => {
			for (let level = 0; level < h; level++) {
				const r = Math.random();
				pieces.push({
					i: i0 + k,
					j: base - level,
					// Mostly the gathering's own tone, with a neighbour's piece here and there.
					tone: r < 0.78 ? tone : (tone + (r < 0.89 ? 1 : 2)) % 3,
					kind: Math.floor(Math.random() * 3),
					order: (level / tall) * 0.72 + (k / w) * 0.18 + Math.random() * 0.1,
					top: (h - 1 - level) / tall
				});
			}
		});
		heaps.push({
			box: {
				left: i0 * cell,
				top: (base + 1 - tall) * cell,
				right: (i0 + w) * cell,
				bottom: (base + 1) * cell
			},
			cx,
			cy,
			tone,
			pieces,
			born: at,
			buildMs,
			holdMs
		});
	}

	/** Knocks a heap over: every piece still standing tumbles away from the centre. */
	function knockOver(heap: Heap, at: number, from = { x: heap.cx, y: heap.cy + cell }) {
		const u = at - heap.born;
		for (const p of heap.pieces) {
			if (pieceState(heap, p, u).show <= 0) continue;
			const x = p.i * cell + cell / 2;
			const y = p.j * cell + cell / 2;
			const away = Math.atan2(y - from.y, x - from.x);
			const speed = 0.18 + Math.random() * 0.22;
			flyers.push({
				piece: p,
				x,
				y,
				vx: Math.cos(away) * speed + (Math.random() - 0.5) * 0.08,
				vy: Math.sin(away) * speed - 0.25 - Math.random() * 0.15,
				spin: 0,
				vspin: (Math.random() - 0.5) * 0.02,
				born: at
			});
		}
		heaps.splice(heaps.indexOf(heap), 1);
	}

	/** How far a piece has arrived (0 → 1) and left (0 → 1) at heap time `u`. */
	function pieceState(heap: Heap, p: Piece, u: number) {
		const arrive = clamp01((u / heap.buildMs - p.order) * 6);
		const leave = clamp01(((u - heap.buildMs - heap.holdMs) / CLEAR_MS - p.top * 0.85) * 5);
		return { arrive, leave, show: arrive > 0 && leave < 1 ? 1 : 0 };
	}

	/** 0 → 1 while the heap builds, 1 while it holds, back to 0 as it clears. */
	const presence = (heap: Heap, t: number) => {
		const u = t - heap.born;
		const end = heap.buildMs + heap.holdMs;
		return Math.min(smoothstep(0, heap.buildMs * 0.7, u), 1 - smoothstep(end, end + CLEAR_MS, u));
	};

	function drawPiece(p: Piece, x: number, y: number, scale: number, alpha: number, spin = 0) {
		if (spin) {
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(spin);
			drawPiece(p, 0, 0, scale, alpha);
			ctx.restore();
			return;
		}
		const half = (cell / 2) * scale * 0.92;
		const tone = colors.tones[p.tone];
		ctx.globalAlpha = alpha;
		ctx.fillStyle = tone;
		if (p.kind === 0) {
			// a tone tile with an octagon cut through it (the pattern's "ink dots on the tone")
			ctx.fillRect(x - half, y - half, half * 2, half * 2);
			ctx.globalCompositeOperation = 'destination-out';
			ctx.globalAlpha = 1;
			ctx.beginPath();
			octagonPath(ctx, x, y, half * 0.46, 0.55);
			ctx.fill();
			ctx.globalCompositeOperation = 'source-over';
		} else if (p.kind === 1) {
			// a full octagon tile
			ctx.beginPath();
			octagonPath(ctx, x, y, half, 0.55);
			ctx.fill();
		} else {
			// a tone dot on a faint tile of the same tone
			ctx.globalAlpha = alpha * 0.28;
			ctx.fillRect(x - half, y - half, half * 2, half * 2);
			ctx.globalAlpha = alpha;
			ctx.beginPath();
			octagonPath(ctx, x, y, half * 0.46, 0.55);
			ctx.fill();
		}
	}

	function draw(t: number) {
		ctx.clearRect(0, 0, width, height);

		// The resting grid, in one path.
		ctx.globalAlpha = DOT_ALPHA;
		ctx.fillStyle = colors.line;
		ctx.beginPath();
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++)
				octagonPath(ctx, i * cell + cell / 2, j * cell + cell / 2, DOT_R);
		}
		ctx.fill();

		// The drift, warmed further around each heap as its colour gathers.
		const gathers = heaps.map((heap) => ({ heap, amount: presence(heap, t) }));
		const rings = ripples.map((r) => {
			const age = (t - r.born) / RIPPLE_MS;
			return { ...r, radius: (t - r.born) * RIPPLE_SPEED, fade: (1 - age) ** 1.5 };
		});
		for (let j = 0; j < rows; j++) {
			for (let i = 0; i < cols; i++) {
				const x = i * cell + cell / 2;
				const y = j * cell + cell / 2;
				let glow = smoothstep(0.66, 0.96, wave(x, y, t));
				let tone = -1;
				let swell = 0;
				const trail = heat[j * cols + i];
				if (trail > glow) {
					glow = trail;
					tone = heatTone[j * cols + i];
				}
				for (const r of rings) {
					const ring = Math.max(
						0,
						1 - Math.abs(Math.hypot(x - r.x, y - r.y) - r.radius) / RIPPLE_WIDTH
					);
					const lit = ring * ring * r.fade;
					if (lit > 0.02) swell = Math.max(swell, lit * 0.8);
					if (lit > glow) {
						glow = lit;
						tone = r.tone;
					}
				}
				if (pointer) {
					const reach =
						Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / HOVER_REACH) ** 2;
					swell = Math.max(swell, reach);
					if (reach > glow) {
						glow = reach;
						tone = brushTone;
					}
				}
				for (const { heap, amount } of gathers) {
					if (amount <= 0) continue;
					const near = Math.max(0, 1 - Math.hypot(x - heap.cx, y - heap.cy) / GATHER_REACH) ** 2;
					const warm = near * amount * 0.85;
					if (warm > glow) {
						glow = warm;
						tone = heap.tone;
					}
				}
				if (
					exclusion &&
					x > exclusion.left &&
					x < exclusion.right &&
					y > exclusion.top &&
					y < exclusion.bottom
				) {
					glow *= EXCLUSION_DAMP;
					swell *= EXCLUSION_DAMP;
				}
				if (glow < 0.03) continue;
				ctx.fillStyle = colors.tones[tone >= 0 ? tone : bandTone(x, y, t)];
				ctx.globalAlpha = glow * (GLOW_ALPHA + swell * 0.35);
				ctx.beginPath();
				octagonPath(ctx, x, y, DOT_R + glow * GLOW_GROW + swell * HOVER_GROW);
				ctx.fill();
			}
		}

		// The heaps.
		for (const heap of heaps) {
			const u = t - heap.born;
			for (const p of heap.pieces) {
				const { arrive, leave, show } = pieceState(heap, p, u);
				if (!show) continue;
				const x = p.i * cell + cell / 2;
				const y = p.j * cell + cell / 2;
				const drop = (1 - easeOutBack(arrive)) * -cell * 2.2;
				let scale = Math.min(1, 0.6 + arrive * 0.4) * (1 - leave);
				let lift = 0;
				if (pointer) {
					const near = Math.max(0, 1 - Math.hypot(x - pointer.x, y - pointer.y) / LIFT_REACH);
					lift = -near * near * 7;
					scale *= 1 + near * 0.1;
				}
				drawPiece(
					p,
					x,
					y + drop + lift,
					scale,
					PIECE_ALPHA * Math.min(1, arrive * 1.5) * (1 - leave * 0.6)
				);
			}
		}

		// Pieces knocked loose.
		for (const f of flyers) {
			const age = (t - f.born) / FLYER_MS;
			drawPiece(f.piece, f.x, f.y, 1 - age * 0.4, PIECE_ALPHA * (1 - age) ** 1.4, f.spin);
		}
		ctx.globalAlpha = 1;

		if (!painted) {
			painted = true;
			onFirstFrame?.();
		}
	}

	function step(t: number, dt: number) {
		if (dt > 0) {
			const decay = Math.exp(-dt / TRAIL_TAU_MS);
			for (let n = 0; n < heat.length; n++) heat[n] = heat[n] < 0.01 ? 0 : heat[n] * decay;
		}
		for (let n = ripples.length - 1; n >= 0; n--) {
			if (t - ripples[n].born > RIPPLE_MS) ripples.splice(n, 1);
		}
		for (let n = flyers.length - 1; n >= 0; n--) {
			const f = flyers[n];
			if (t - f.born > FLYER_MS) {
				flyers.splice(n, 1);
				continue;
			}
			f.vy += GRAVITY * dt;
			f.x += f.vx * dt;
			f.y += f.vy * dt;
			f.spin += f.vspin * dt;
		}
		for (let n = heaps.length - 1; n >= 0; n--) {
			const heap = heaps[n];
			if (t - heap.born > heap.buildMs + heap.holdMs + CLEAR_MS + 300) {
				heaps.splice(n, 1);
				// A cleared spot rests before the next heap gathers.
				nextHeapAt = Math.max(nextHeapAt, t + between(REST_MS, Math.random()));
			}
		}
		if (t >= nextHeapAt && heaps.length < MAX_HEAPS) {
			// Stagger the second heap so the two never build in step.
			nextHeapAt = t + (spawnHeap(t) ? BUILD_MS + between(REST_MS, Math.random()) : 1500);
		}
	}

	/** Warms the cells along the pointer's path from (x0, y0) to (x1, y1). */
	function stamp(x0: number, y0: number, x1: number, y1: number) {
		const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cell / 2)));
		const reach = TRAIL_RADIUS * cell;
		for (let s = 1; s <= steps; s++) {
			const x = x0 + ((x1 - x0) * s) / steps;
			const y = y0 + ((y1 - y0) * s) / steps;
			const damp =
				exclusion &&
				x > exclusion.left &&
				x < exclusion.right &&
				y > exclusion.top &&
				y < exclusion.bottom
					? EXCLUSION_DAMP
					: 1;
			const ci = Math.round(x / cell - 0.5);
			const cj = Math.round(y / cell - 0.5);
			for (let j = cj - 2; j <= cj + 2; j++) {
				for (let i = ci - 2; i <= ci + 2; i++) {
					if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
					const d = Math.hypot(i * cell + cell / 2 - x, j * cell + cell / 2 - y);
					const amount = Math.max(0, 1 - d / reach) * 0.75 * damp;
					const n = j * cols + i;
					if (amount > heat[n]) {
						heat[n] = amount;
						heatTone[n] = brushTone;
					}
				}
			}
		}
	}

	function playAlong(target: HTMLElement) {
		const local = (event: PointerEvent) => {
			const rect = host.getBoundingClientRect();
			return { x: event.clientX - rect.left, y: event.clientY - rect.top };
		};
		const move = (event: PointerEvent) => {
			const at = local(event);
			if (pointer && event.pointerType === 'mouse') {
				const d = Math.hypot(at.x - pointer.x, at.y - pointer.y);
				stamp(pointer.x, pointer.y, at.x, at.y);
				travelled += d;
				if (travelled > TRAIL_TONE_STEP) {
					travelled = 0;
					brushTone = (brushTone + 1) % 3;
				}
			}
			pointer = event.pointerType === 'mouse' ? at : null;
		};
		const leave = () => (pointer = null);
		const down = (event: PointerEvent) => {
			if (event.button !== 0) return;
			if (event.target instanceof Element && event.target.closest(CONTROLS)) return;
			const at = local(event);
			if (
				exclusion &&
				at.x > exclusion.left &&
				at.x < exclusion.right &&
				at.y > exclusion.top &&
				at.y < exclusion.bottom
			) {
				return;
			}
			const hit = heaps.find(
				(h) =>
					at.x > h.box.left - cell / 2 &&
					at.x < h.box.right + cell / 2 &&
					at.y > h.box.top - cell &&
					at.y < h.box.bottom + cell / 2
			);
			ripples.push({ x: at.x, y: at.y, born: clock, tone: brushTone });
			if (hit) knockOver(hit, clock, at);
			else spawnHeapAt(at.x, at.y, brushTone, clock);
			brushTone = (brushTone + 1) % 3;
		};
		const offs = [
			on(target, 'pointermove', move, { passive: true }),
			on(target, 'pointerleave', leave),
			on(target, 'pointerdown', down)
		];
		return () => offs.forEach((off) => off());
	}

	resize();

	if (still) {
		// One heap, built and holding.
		const t = 4000;
		spawnHeap(t - BUILD_MS * 1.2);
		draw(t);
		const resizeObserver = new ResizeObserver(() => {
			resize();
			spawnHeap(t - BUILD_MS * 1.2);
			draw(t);
		});
		resizeObserver.observe(host);
		return { destroy: () => resizeObserver.disconnect() };
	}

	const frame = (now: number) => {
		raf = requestAnimationFrame(frame);
		const dt = lastNow ? Math.min(MAX_DT, now - lastNow) : 0;
		lastNow = now;
		if (!visible || document.hidden) return;
		clock += dt;
		if (now - lastDraw < FRAME_MS) return;
		lastDraw = now;
		if (++frames % EXCLUSION_REFRESH_FRAMES === 0) exclusion = readExclusion();
		if (frames % 30 === 0) colors = palette();
		step(clock, clock - lastStep);
		lastStep = clock;
		draw(clock);
	};

	const resizeObserver = new ResizeObserver(() => {
		resize();
		draw(clock);
	});
	resizeObserver.observe(host);
	const intersection = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? true;
	});
	intersection.observe(host);
	const offPointer = pointerTarget ? playAlong(pointerTarget) : () => {};
	draw(clock);
	raf = requestAnimationFrame(frame);

	return {
		destroy() {
			cancelAnimationFrame(raf);
			resizeObserver.disconnect();
			intersection.disconnect();
			offPointer();
		}
	};
}

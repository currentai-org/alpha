/**
 * Hero field — “the potluck assembles.”
 *
 * A 45° lattice (the Potluck diamond, tiled). Pieces travel in along the lattice lines from a few
 * directions at once — several contributors, each bringing part of the dish — leave a short-lived
 * trace of where they came from, and settle into a small nature vignette (pines, a sunrise, a
 * sprout…), drawn upright in diamond cells. When the last piece lands, a diamond ripple runs out
 * through the lattice. After a while the vignette lets its pieces go again, back out along the lines,
 * and another assembles in its place. In the lively variant faint ink packets also cross the field,
 * and the pointer warms the cells it passes over.
 *
 * Two variants: `lively` for the /alpha hero, `quiet` behind the new-chat screen (fewer, slower,
 * dimmer; no ripple, packets or pointer). Plain canvas 2D, one layer. Pauses while off-screen; a
 * still composition under reduced motion.
 */

import { on } from 'svelte/events';
import {
	NATURE_GLYPH_DIAMONDS,
	glyphCells,
	shuffledNatureGlyphs,
	type GlyphTone,
	type NatureGlyph
} from './alpha-hero-nature-glyphs';

export type AlphaHeroGridHandle = {
	destroy: () => void;
};

/** Resolved CSS colours (any syntax the canvas accepts, e.g. `oklch(…)`). */
export type AlphaHeroGridPalette = { accent: string; line: string };

export type AlphaHeroGridVariant = 'lively' | 'quiet';

export type AlphaHeroGridOptions = {
	canvas: HTMLCanvasElement;
	host: HTMLElement;
	onFirstFrame?: () => void;
	/**
	 * Theme-aware colours, re-read about twice a second so a theme or mode switch follows live.
	 * Omitted → the /alpha page's fixed salmon-on-paper palette.
	 */
	palette?: () => AlphaHeroGridPalette;
	/** Leave the canvas transparent (no paper fill) so the surface behind shows through. */
	transparent?: boolean;
	/** The element glyphs and traffic keep clear of. Default: `.alpha-hero-copy` in the hero stage. */
	exclude?: () => HTMLElement | null;
	/** How much happens. Default `lively`. */
	variant?: AlphaHeroGridVariant;
};

type Range = readonly [number, number];

type Tuning = {
	cellSize: (viewW: number) => number;
	maxSites: number;
	firstDelayMs: number;
	staggerMs: number;
	holdMs: Range;
	restMs: Range;
	/** Contributor reach, in lattice units (half cells). */
	reach: Range;
	/** Piece speed, in lattice units per ms. */
	speed: Range;
	/** Largest arrival delay spread per piece. */
	scatterMs: number;
	/** Share of pieces that leave on a long journey. */
	farShare: number;
	glyphAlpha: number;
	inkAlpha: number;
	trailAlpha: number;
	traceScale: number;
	ripple: boolean;
	strays: boolean;
	pointer: boolean;
	shimmer: boolean;
};

const TUNING: Record<AlphaHeroGridVariant, Tuning> = {
	lively: {
		cellSize: (w) => (w < 480 ? 16 : w < 900 ? 19 : 22),
		maxSites: 2,
		firstDelayMs: 300,
		staggerMs: 1200,
		holdMs: [5600, 7600],
		restMs: [500, 1600],
		reach: [18, 34],
		speed: [0.022, 0.03],
		scatterMs: 650,
		farShare: 0.22,
		glyphAlpha: 0.9,
		inkAlpha: 0.42,
		trailAlpha: 0.5,
		traceScale: 1,
		ripple: true,
		strays: true,
		pointer: true,
		shimmer: true
	},
	quiet: {
		cellSize: (w) => (w < 900 ? 13 : 15),
		maxSites: 2,
		firstDelayMs: 900,
		staggerMs: 5200,
		holdMs: [11000, 15000],
		restMs: [3000, 6000],
		reach: [6, 12],
		speed: [0.007, 0.0095],
		scatterMs: 1400,
		farShare: 0,
		glyphAlpha: 0.62,
		inkAlpha: 0.32,
		trailAlpha: 0.22,
		traceScale: 0.45,
		ripple: false,
		strays: false,
		pointer: false,
		shimmer: false
	}
};

const GRID_ANGLE = Math.PI / 4;
const COS = Math.cos(GRID_ANGLE);
const SIN = Math.sin(GRID_ANGLE);
/**
 * Lattice units per grid cell. Everything moves and is drawn on a half-size sub-lattice so the
 * vignettes get twice the detail; the drawn grid lines still sit every SUB units.
 */
const SUB = 2;
const CELL_INSET = 0.7;
/** Every Nth lattice node is marked with a small diamond, like a map's graticule. */
const NODE_EVERY = 4;
const LINE_ALPHA = 0.07;
const NODE_ALPHA = 0.2;
/** Heat (traces, ripples, pointer warmth) decays with this time constant. */
const HEAT_TAU_MS = 1100;
const HEAT_ALPHA = 0.3;
/** Multiplier on each glyph's `frameMs` while it holds. */
const SPRITE_FRAME_MULTIPLIER = 1;
const RIPPLE_REACH = 18;
const RIPPLE_MS = 1500;
const STRAY_EVERY_MS: Range = [1800, 4200];
const TRAIL_STEPS = 4;
const TRAIL_SPACING = 1.25;
/** Clock step cap, so a backgrounded tab resumes where it left off instead of jumping. */
const MAX_DT = 50;
const EXCLUSION_REFRESH_FRAMES = 15;
/** Motes and heat under the excluded element are damped to this fraction. */
const EXCLUSION_DAMP = 0.15;
const COPY_EXCLUSION_PAD_X = 32;
const COPY_EXCLUSION_PAD_Y = 24;

const ORANGE = { r: 248, g: 131, b: 118 };
const PAPER = { r: 247, g: 246, b: 246 };
const INK_LINE = { r: 11, g: 37, b: 47 };

type Vec = { x: number; y: number };
type Rgb = { r: number; g: number; b: number };
type ScreenRect = { left: number; top: number; right: number; bottom: number };

/** The four lattice directions. On screen they are the four diagonals. */
const DIRS: readonly Vec[] = [
	{ x: 1, y: 0 },
	{ x: -1, y: 0 },
	{ x: 0, y: 1 },
	{ x: 0, y: -1 }
];

type Phase = 'idle' | 'assembling' | 'holding' | 'releasing';

type Site = {
	slotId: number;
	phase: Phase;
	/** idle → when to start assembling; holding → when to release. */
	until: number;
	glyph: NatureGlyph | null;
	/** Lattice cell the glyph is centred on. */
	ax: number;
	ay: number;
	/** Indices (into frame 0) of pieces that have landed during assembly. */
	landed: Set<number>;
	pending: number;
	frame: number;
	nextFrameAt: number;
	breath: number;
};

type MoteKind = 'arrive' | 'depart' | 'stray';

type Mote = {
	kind: MoteKind;
	tone: GlyphTone;
	/** Axis-aligned waypoints in lattice cells. */
	path: Vec[];
	len: number;
	start: number;
	dur: number;
	/** Last whole cell along the path that has left a trace. */
	deposited: number;
	site: Site | null;
	key: number;
	done: boolean;
};

type Ripple = { cx: number; cy: number; start: number; r0: number; last: number };

function readHexVar(name: string, fallback: Rgb): Rgb {
	if (typeof document === 'undefined') return fallback;
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	if (!v?.startsWith('#')) return fallback;
	const hex = v.slice(1);
	const full =
		hex.length === 3
			? hex
					.split('')
					.map((c) => c + c)
					.join('')
			: hex;
	const n = Number.parseInt(full, 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const between = ([a, b]: Range) => a + Math.random() * (b - a);

function pathLength(path: readonly Vec[]): number {
	let len = 0;
	for (let i = 0; i < path.length - 1; i++) {
		len += Math.abs(path[i + 1].x - path[i].x) + Math.abs(path[i + 1].y - path[i].y);
	}
	return len;
}

/** Position `s` cells along an axis-aligned path. */
function pointAt(m: Mote, s: number): Vec {
	let rem = Math.max(0, Math.min(m.len, s));
	for (let i = 0; i < m.path.length - 1; i++) {
		const a = m.path[i];
		const b = m.path[i + 1];
		const seg = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
		if (rem <= seg || i === m.path.length - 2) {
			const t = seg === 0 ? 1 : rem / seg;
			return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
		}
		rem -= seg;
	}
	return m.path[m.path.length - 1];
}

function easeFor(kind: MoteKind, p: number): number {
	if (kind === 'arrive') return 1 - (1 - p) * (1 - p);
	if (kind === 'depart') return p ** 1.7;
	return p;
}

const pointInRect = (x: number, y: number, rect: ScreenRect) =>
	x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

export function createAlphaHeroGridField(opts: AlphaHeroGridOptions): AlphaHeroGridHandle {
	const { canvas, host, onFirstFrame, palette, transparent = false, exclude } = opts;
	const tune = TUNING[opts.variant ?? 'lively'];
	const ctx = canvas.getContext('2d', { alpha: transparent });
	if (!ctx) throw new Error('Canvas 2D unavailable');

	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const finePointer = window.matchMedia('(pointer: fine)').matches;

	let destroyed = false;
	let raf = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastNow = 0;
	let firstFrame = false;
	let visible = true;
	let frameCount = 0;
	/** Field time in ms. Advances by capped steps, so it pauses with the page. */
	let clock = 0;

	let cols = 0;
	let rows = 0;
	let cellSize = 22;
	/** Size of one lattice unit in px (cellSize / SUB). */
	let unit = 11;
	let gridLeft = 0;
	let gridTop = 0;
	let viewW = 1;
	let viewH = 1;
	let heat: Float32Array = new Float32Array(0);

	const sites: Site[] = [];
	const motes: Mote[] = [];
	const ripples: Ripple[] = [];
	let glyphQueue = shuffledNatureGlyphs();
	let glyphIndex = 0;
	let nextStrayAt = 1200;
	let cachedExclusion: ScreenRect | null = null;
	let lastPointerCell = -1;

	const findCopy = (): Element | null | undefined =>
		exclude ? exclude() : host.closest('.alpha-hero-stage')?.querySelector('.alpha-hero-copy');

	// Colours: the caller's theme palette (re-read ~every 30 frames) or the fixed /alpha palette.
	let colors: AlphaHeroGridPalette | null = null;
	let colorFrames = 0;
	const readColors = (): AlphaHeroGridPalette => {
		if (palette) {
			if (!colors || ++colorFrames >= 30) {
				colors = palette();
				colorFrames = 0;
			}
			return colors;
		}
		const o = readHexVar('--salmon', ORANGE);
		return {
			accent: `rgb(${o.r} ${o.g} ${o.b})`,
			line: `rgb(${INK_LINE.r} ${INK_LINE.g} ${INK_LINE.b})`
		};
	};

	const readCopyExclusion = (): ScreenRect | null => {
		const copy = findCopy();
		if (!(copy instanceof HTMLElement)) return null;
		const hostRect = host.getBoundingClientRect();
		const copyRect = copy.getBoundingClientRect();
		return {
			left: copyRect.left - hostRect.left - COPY_EXCLUSION_PAD_X,
			top: copyRect.top - hostRect.top - COPY_EXCLUSION_PAD_Y,
			right: copyRect.right - hostRect.left + COPY_EXCLUSION_PAD_X,
			bottom: copyRect.bottom - hostRect.top + COPY_EXCLUSION_PAD_Y
		};
	};

	// ── Lattice geometry ────────────────────────────────────────────────────────

	const layoutGrid = (w: number, h: number) => {
		viewW = w;
		viewH = h;
		cellSize = tune.cellSize(w);
		unit = cellSize / SUB;
		const span = (Math.ceil(Math.hypot(w, h) / cellSize) + 8) * SUB;
		cols = span;
		rows = span;
		heat = new Float32Array(cols * rows);
		gridLeft = w / 2 - (cols * unit) / 2;
		gridTop = h / 2 - (rows * unit) / 2;
	};

	/** Screen position of a (fractional) cell's centre. */
	const gridToScreen = (gx: number, gy: number) => {
		const dx = gridLeft + (gx + 0.5) * unit - viewW / 2;
		const dy = gridTop + (gy + 0.5) * unit - viewH / 2;
		return { sx: viewW / 2 + dx * COS - dy * SIN, sy: viewH / 2 + dx * SIN + dy * COS };
	};

	const screenToGrid = (sx: number, sy: number) => {
		const dx = sx - viewW / 2;
		const dy = sy - viewH / 2;
		const px = viewW / 2 + dx * COS + dy * SIN;
		const py = viewH / 2 - dx * SIN + dy * COS;
		return {
			gx: Math.round((px - gridLeft) / unit - 0.5),
			gy: Math.round((py - gridTop) / unit - 0.5)
		};
	};

	const inExclusion = (gx: number, gy: number) => {
		if (!cachedExclusion) return false;
		const { sx, sy } = gridToScreen(gx, gy);
		return pointInRect(sx, sy, cachedExclusion);
	};

	const addHeat = (gx: number, gy: number, amount: number) => {
		if (gx < 0 || gy < 0 || gx >= cols || gy >= rows) return;
		const i = gy * cols + gx;
		heat[i] = Math.min(1, heat[i] + (inExclusion(gx, gy) ? amount * EXCLUSION_DAMP : amount));
	};

	// ── Glyph placement ─────────────────────────────────────────────────────────

	const targetGlyphCount = () => tune.maxSites;

	const viewportSlots = (ex: ScreenRect | null): { sx: number; sy: number }[] => {
		const t = targetGlyphCount();
		if (!ex || ex.right <= ex.left || ex.bottom <= ex.top) {
			const midY = viewH * 0.34;
			return [
				{ sx: viewW * 0.12, sy: midY - 20 },
				{ sx: viewW * 0.88, sy: midY + 16 },
				{ sx: viewW * 0.14, sy: midY + 64 }
			].slice(0, t);
		}

		// Centred in the free margin either side of the copy (vignettes may clip at the viewport edge on
		// narrow screens), kept within the copy's own height so nothing below it — like the demo
		// window under the /alpha hero — covers them; left sits a little higher than right.
		const span = NATURE_GLYPH_DIAMONDS * unit * Math.SQRT2;
		const midY = (ex.top + ex.bottom) / 2;
		const lo = ex.top + span * 0.4;
		const hi = ex.bottom - span * 0.4;
		const clampY = (y: number) => (lo < hi ? Math.min(hi, Math.max(lo, y)) : midY);
		return [
			{ sx: Math.max(12, ex.left / 2), sy: clampY(midY - span * 0.2) },
			{ sx: Math.min(viewW - 12, ex.right + (viewW - ex.right) / 2), sy: clampY(midY + span * 0.2) }
		].slice(0, t);
	};

	const nextGlyph = (): NatureGlyph => {
		if (glyphIndex >= glyphQueue.length) {
			glyphQueue = shuffledNatureGlyphs();
			glyphIndex = 0;
		}
		return glyphQueue[glyphIndex++];
	};

	/** Anchor `glyph` at the site's slot. False when the slot is missing or under the copy. */
	const placeGlyph = (site: Site, glyph: NatureGlyph): boolean => {
		const slot = viewportSlots(cachedExclusion)[site.slotId];
		if (!slot) return false;
		if (cachedExclusion && pointInRect(slot.sx, slot.sy, cachedExclusion)) return false;
		const { gx, gy } = screenToGrid(slot.sx, slot.sy);
		site.glyph = glyph;
		site.ax = gx;
		site.ay = gy;
		return true;
	};

	const newSite = (slotId: number, until: number): Site => ({
		slotId,
		phase: 'idle',
		until,
		glyph: null,
		ax: 0,
		ay: 0,
		landed: new Set(),
		pending: 0,
		frame: 0,
		nextFrameAt: 0,
		breath: Math.random() * Math.PI * 2
	});

	const toIdle = (site: Site, restMs: number) => {
		site.phase = 'idle';
		site.until = clock + restMs;
		site.landed.clear();
		site.pending = 0;
	};

	const beginHold = (site: Site, ripple: boolean) => {
		if (!site.glyph) return;
		site.phase = 'holding';
		site.until = reducedMotion ? Number.POSITIVE_INFINITY : clock + between(tune.holdMs);
		site.frame = 0;
		site.nextFrameAt = clock + site.glyph.frameMs * SPRITE_FRAME_MULTIPLIER;
		site.landed.clear();
		if (!ripple || !tune.ripple) return;
		const r0 = site.glyph.radius + 1;
		ripples.push({ cx: site.ax, cy: site.ay, start: clock, r0, last: r0 - 1 });
	};

	const spawnMote = (
		kind: MoteKind,
		tone: GlyphTone,
		path: Vec[],
		start: number,
		dur: number,
		site: Site | null,
		key = 0
	) => {
		motes.push({
			kind,
			tone,
			path,
			len: pathLength(path),
			start,
			dur,
			deposited: 0,
			site,
			key,
			done: false
		});
	};

	/**
	 * Pieces arrive from two or three directions — one per contributor — each mostly bringing the
	 * side of the vignette that faces it. About a third take a jog on the way in, like a routed trace.
	 */
	const startAssembly = (site: Site) => {
		const glyph = nextGlyph();
		if (!placeGlyph(site, glyph)) {
			site.until = clock + 900;
			return;
		}
		// Contributors come from the directions whose approach is most visible, and never across the
		// copy: sample each straight approach and score the share of it that is on screen and clear.
		const scored = DIRS.map((dir) => {
			let clear = 0;
			let blocked = false;
			const samples = 8;
			for (let i = 1; i <= samples; i++) {
				const k = glyph.radius + (i * tune.reach[1]) / samples;
				const { sx, sy } = gridToScreen(site.ax + dir.x * k, site.ay + dir.y * k);
				if (cachedExclusion && pointInRect(sx, sy, cachedExclusion)) blocked = true;
				else if (sx >= 0 && sx <= viewW && sy >= 0 && sy <= viewH) clear++;
			}
			return { dir, blocked, score: clear / samples + Math.random() * 0.35 };
		});
		let open = scored.filter((d) => !d.blocked);
		if (open.length < 2) open = scored;
		const allowed = open.sort((a, b) => b.score - a.score).map((d) => d.dir);
		const count = Math.min(allowed.length, Math.random() < 0.5 ? 2 : 3);
		const contributors = allowed.slice(0, count).map((dir, i) => ({
			dir,
			reach: between(tune.reach),
			delay: i * 380 + Math.random() * 200,
			speed: between(tune.speed)
		}));

		site.phase = 'assembling';
		site.landed.clear();
		site.pending = 0;
		site.frame = 0;

		const cells = glyphCells(glyph, 0);
		cells.forEach((cell, index) => {
			let best = contributors[0];
			let bestScore = Number.NEGATIVE_INFINITY;
			for (const c of contributors) {
				const score = cell.a * c.dir.x + cell.b * c.dir.y + Math.random() * 6;
				if (score > bestScore) {
					bestScore = score;
					best = c;
				}
			}
			const { dir } = best;
			const perp = { x: dir.y, y: dir.x };
			const t = { x: site.ax + cell.a, y: site.ay + cell.b };
			const d = Math.round(best.reach + Math.random() * 8);
			let path: Vec[];
			if (d > 10 && Math.random() < 0.35) {
				const j = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.floor(Math.random() * 5));
				const dj = Math.max(2, Math.round(d * (0.3 + Math.random() * 0.3)));
				path = [
					{ x: t.x + dir.x * d + perp.x * j, y: t.y + dir.y * d + perp.y * j },
					{ x: t.x + dir.x * dj + perp.x * j, y: t.y + dir.y * dj + perp.y * j },
					{ x: t.x + dir.x * dj, y: t.y + dir.y * dj },
					t
				];
			} else {
				path = [{ x: t.x + dir.x * d, y: t.y + dir.y * d }, t];
			}
			const start = clock + best.delay + Math.random() * tune.scatterMs;
			spawnMote('arrive', cell.tone, path, start, pathLength(path) / best.speed, site, index);
			site.pending++;
		});
		if (site.pending === 0) beginHold(site, false);
	};

	/** Pieces leave from the centre outward — a diamond bloom — and a few travel far. */
	const startRelease = (site: Site) => {
		const glyph = site.glyph;
		if (!glyph) return toIdle(site, between(tune.restMs));
		site.phase = 'releasing';
		site.landed.clear();
		site.pending = 0;
		const slow = tune.speed[0] / TUNING.lively.speed[0];
		for (const cell of glyphCells(glyph, site.frame)) {
			const { a, b } = cell;
			let dir: Vec;
			if (Math.abs(a) > Math.abs(b)) dir = { x: Math.sign(a), y: 0 };
			else if (Math.abs(b) > Math.abs(a)) dir = { x: 0, y: Math.sign(b) };
			else if (a === 0) dir = DIRS[Math.floor(Math.random() * 4)];
			else dir = Math.random() < 0.5 ? { x: Math.sign(a), y: 0 } : { x: 0, y: Math.sign(b) };
			const far = Math.random() < tune.farShare;
			const d = Math.round(far ? 20 + Math.random() * 20 : 4 + Math.random() * 8);
			const t = { x: site.ax + a, y: site.ay + b };
			const ring = Math.max(Math.abs(a), Math.abs(b));
			spawnMote(
				'depart',
				cell.tone,
				[t, { x: t.x + dir.x * d, y: t.y + dir.y * d }],
				clock + (ring * 35 + Math.random() * 160) / slow,
				far ? d / 0.024 : (700 + Math.random() * 500) / slow,
				site
			);
			site.pending++;
		}
		if (site.pending === 0) toIdle(site, between(tune.restMs));
	};

	/** A lone packet crossing the whole field along one lattice line. */
	const spawnStray = () => {
		const { gx, gy } = screenToGrid(Math.random() * viewW, Math.random() * viewH);
		const dir = DIRS[Math.floor(Math.random() * 4)];
		const reach = Math.ceil(Math.hypot(viewW, viewH) / unit / 2) + 8;
		const path = [
			{ x: gx - dir.x * reach, y: gy - dir.y * reach },
			{ x: gx + dir.x * reach, y: gy + dir.y * reach }
		];
		spawnMote('stray', 'ink', path, clock, (2 * reach) / (0.014 + Math.random() * 0.008), null);
	};

	const syncSites = () => {
		const target = targetGlyphCount();
		while (sites.length < target) {
			sites.push(newSite(sites.length, clock + tune.firstDelayMs + sites.length * tune.staggerMs));
		}
		sites.length = target;
	};

	// ── Simulation ──────────────────────────────────────────────────────────────

	const finishMote = (m: Mote) => {
		m.done = true;
		const site = m.site;
		if (!site) return;
		site.pending = Math.max(0, site.pending - 1);
		if (m.kind === 'arrive' && site.phase === 'assembling') {
			site.landed.add(m.key);
			const end = m.path[m.path.length - 1];
			addHeat(end.x, end.y, 0.35 * tune.traceScale);
			if (site.pending === 0) beginHold(site, true);
		} else if (m.kind === 'depart' && site.phase === 'releasing' && site.pending === 0) {
			toIdle(site, between(tune.restMs));
		}
	};

	const step = (dt: number) => {
		clock += dt;

		if (reducedMotion) {
			for (const site of sites) {
				if (site.phase !== 'idle') continue;
				if (placeGlyph(site, nextGlyph())) beginHold(site, false);
			}
			return;
		}

		for (const site of sites) {
			if (site.phase === 'idle' && clock >= site.until) startAssembly(site);
			else if (site.phase === 'holding') {
				if (clock >= site.until) startRelease(site);
				else if (site.glyph && clock >= site.nextFrameAt) {
					site.frame += 1;
					site.nextFrameAt = clock + site.glyph.frameMs * SPRITE_FRAME_MULTIPLIER;
				}
			}
		}

		if (tune.strays && clock >= nextStrayAt) {
			spawnStray();
			nextStrayAt = clock + between(STRAY_EVERY_MS);
		}

		const trace = { arrive: 0.14, depart: 0.08, stray: 0.05 } as const;
		for (const m of motes) {
			const p = (clock - m.start) / m.dur;
			if (p < 0) continue;
			const s = easeFor(m.kind, Math.min(1, p)) * m.len;
			while (m.deposited < Math.floor(s)) {
				m.deposited++;
				const c = pointAt(m, m.deposited);
				addHeat(Math.round(c.x), Math.round(c.y), trace[m.kind] * tune.traceScale);
			}
			if (p >= 1) finishMote(m);
		}
		for (let i = motes.length - 1; i >= 0; i--) if (motes[i].done) motes.splice(i, 1);

		for (let i = ripples.length - 1; i >= 0; i--) {
			const rp = ripples[i];
			const t = Math.min(1, (clock - rp.start) / RIPPLE_MS);
			const r = rp.r0 + Math.floor((1 - (1 - t) ** 2) * RIPPLE_REACH);
			for (let rr = rp.last + 1; rr <= r; rr++) {
				const falloff = (1 - (rr - rp.r0) / (RIPPLE_REACH + 1)) ** 1.2;
				const amount = 0.24 * falloff;
				for (let k = -rr; k < rr; k++) {
					addHeat(rp.cx + k, rp.cy - rr, amount);
					addHeat(rp.cx + rr, rp.cy + k, amount);
					addHeat(rp.cx - k, rp.cy + rr, amount);
					addHeat(rp.cx - rr, rp.cy - k, amount);
				}
			}
			rp.last = r;
			if (t >= 1) ripples.splice(i, 1);
		}

		const decay = Math.exp(-dt / HEAT_TAU_MS);
		for (let i = 0; i < heat.length; i++) {
			if (heat[i] === 0) continue;
			heat[i] *= decay;
			if (heat[i] < 0.01) heat[i] = 0;
		}
	};

	// ── Drawing ─────────────────────────────────────────────────────────────────

	/** Fill a (fractional) cell in rotated lattice space. */
	const fillCell = (gx: number, gy: number, inset: number) => {
		const size = unit - inset * 2;
		ctx.fillRect(gridLeft + gx * unit + inset, gridTop + gy * unit + inset, size, size);
	};

	const toneStyle = (tone: GlyphTone, accent: string, line: string) =>
		tone === 'accent'
			? { color: accent, alpha: tune.glyphAlpha }
			: { color: line, alpha: tune.inkAlpha };

	const drawGlyphCells = (site: Site, accent: string, line: string) => {
		const glyph = site.glyph;
		if (!glyph) return;
		const holding = site.phase === 'holding';
		if (!holding && site.phase !== 'assembling') return;
		const cells = glyphCells(glyph, holding ? site.frame : 0);
		const pulse =
			reducedMotion || !tune.shimmer ? 1 : 0.92 + 0.08 * Math.sin(clock * 0.0009 + site.breath);
		cells.forEach((cell, index) => {
			if (!holding && !site.landed.has(index)) return;
			const { color, alpha } = toneStyle(cell.tone, accent, line);
			// A slow shimmer runs across the settled vignette, left to right on screen.
			const shimmer =
				reducedMotion || !tune.shimmer
					? 1
					: 1 - 0.1 * (0.5 + 0.5 * Math.sin(clock * 0.002 - (cell.a - cell.b) * 0.6));
			ctx.fillStyle = color;
			ctx.globalAlpha = alpha * pulse * shimmer;
			fillCell(site.ax + cell.a, site.ay + cell.b, CELL_INSET);
		});
	};

	const drawMote = (m: Mote, accent: string, line: string) => {
		const raw = (clock - m.start) / m.dur;
		if (raw < 0 && m.kind !== 'depart') return;
		const p = Math.max(0, Math.min(1, raw));
		const e = easeFor(m.kind, p);
		const s = e * m.len;
		const pos = pointAt(m, s);
		const final = toneStyle(m.tone, accent, line);

		let alpha: number;
		let inset: number;
		let warm: number; // 0 = open outline, 1 = filled with its final tone
		if (m.kind === 'arrive') {
			alpha = final.alpha * Math.min(1, p * 4);
			inset = unit * 0.28 + (CELL_INSET - unit * 0.28) * e * e;
			warm = e ** 3;
		} else if (m.kind === 'depart') {
			alpha = final.alpha * (1 - p) ** 1.3;
			inset = CELL_INSET + (unit * 0.3 - CELL_INSET) * e;
			warm = 1 - p * 0.8;
		} else {
			alpha = 0.32 * Math.sin(Math.PI * p);
			inset = unit * 0.2;
			warm = 1;
		}
		if (inExclusion(pos.x, pos.y)) alpha *= EXCLUSION_DAMP;
		if (alpha < 0.005) return;

		// Trail: short fading segments back along the path, through cell centres.
		if (s > 0 && m.kind !== 'depart') {
			ctx.strokeStyle = m.kind === 'stray' || m.tone === 'ink' ? line : accent;
			ctx.lineWidth = 1.25;
			let prev = pos;
			for (let i = 1; i <= TRAIL_STEPS; i++) {
				const back = s - i * TRAIL_SPACING;
				if (back < 0) break;
				const q = pointAt(m, back);
				ctx.globalAlpha =
					alpha *
					tune.trailAlpha *
					(1 - i / (TRAIL_STEPS + 1)) *
					(m.kind === 'arrive' ? 0.4 + 0.6 * warm : 1);
				ctx.beginPath();
				ctx.moveTo(gridLeft + (prev.x + 0.5) * unit, gridTop + (prev.y + 0.5) * unit);
				ctx.lineTo(gridLeft + (q.x + 0.5) * unit, gridTop + (q.y + 0.5) * unit);
				ctx.stroke();
				prev = q;
			}
		}

		// The piece itself: an open ink outline while it travels, filling with its final tone as it
		// arrives. Strays stay solid ink.
		if (m.kind === 'stray') {
			ctx.fillStyle = line;
			ctx.globalAlpha = alpha;
			fillCell(pos.x, pos.y, inset);
			return;
		}
		if (warm < 1) {
			const size = unit - inset * 2;
			ctx.strokeStyle = line;
			ctx.lineWidth = 1;
			ctx.globalAlpha = Math.min(1, alpha * 1.4) * (1 - warm) * 0.5;
			ctx.strokeRect(
				gridLeft + pos.x * unit + inset + 0.5,
				gridTop + pos.y * unit + inset + 0.5,
				size - 1,
				size - 1
			);
		}
		if (warm > 0) {
			ctx.fillStyle = final.color;
			ctx.globalAlpha = alpha * warm;
			fillCell(pos.x, pos.y, inset);
		}
	};

	const draw = () => {
		const { accent, line } = readColors();
		const w = viewW;
		const h = viewH;

		ctx.globalAlpha = 1;
		if (transparent) {
			ctx.clearRect(0, 0, w, h);
		} else {
			const paper = readHexVar('--paper', PAPER);
			ctx.fillStyle = `rgb(${paper.r} ${paper.g} ${paper.b})`;
			ctx.fillRect(0, 0, w, h);
		}

		ctx.save();
		ctx.translate(w / 2, h / 2);
		ctx.rotate(GRID_ANGLE);
		ctx.translate(-w / 2, -h / 2);

		ctx.fillStyle = accent;
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < cols; x++) {
				const v = heat[y * cols + x];
				if (v < 0.015) continue;
				ctx.globalAlpha = v * HEAT_ALPHA;
				fillCell(x, y, CELL_INSET + 1.5);
			}
		}

		for (const site of sites) drawGlyphCells(site, accent, line);
		for (const m of motes) drawMote(m, accent, line);

		ctx.strokeStyle = line;
		ctx.globalAlpha = LINE_ALPHA;
		ctx.lineWidth = 1;
		ctx.beginPath();
		const right = gridLeft + cols * unit;
		const bottom = gridTop + rows * unit;
		for (let x = 0; x <= cols; x += SUB) {
			const px = gridLeft + x * unit;
			ctx.moveTo(px, gridTop);
			ctx.lineTo(px, bottom);
		}
		for (let y = 0; y <= rows; y += SUB) {
			const py = gridTop + y * unit;
			ctx.moveTo(gridLeft, py);
			ctx.lineTo(right, py);
		}
		ctx.stroke();

		// Graticule nodes — squares in lattice space, so small diamonds on screen.
		ctx.fillStyle = line;
		ctx.globalAlpha = NODE_ALPHA;
		for (let y = 0; y <= rows; y += NODE_EVERY * SUB) {
			for (let x = 0; x <= cols; x += NODE_EVERY * SUB) {
				ctx.fillRect(gridLeft + x * unit - 1.5, gridTop + y * unit - 1.5, 3, 3);
			}
		}

		ctx.restore();
		ctx.globalAlpha = 1;
	};

	// ── Lifecycle ───────────────────────────────────────────────────────────────

	const resize = () => {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const w = Math.max(1, host.clientWidth);
		const h = Math.max(1, host.clientHeight);
		canvas.width = Math.floor(w * dpr);
		canvas.height = Math.floor(h * dpr);
		canvas.style.width = `${w}px`;
		canvas.style.height = `${h}px`;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		layoutGrid(w, h);
		cachedExclusion = readCopyExclusion();
		motes.length = 0;
		ripples.length = 0;
		syncSites();
		// Settle anything mid-flight at its new position rather than replaying it.
		for (const site of sites) {
			if (site.phase === 'idle') continue;
			if (site.phase === 'releasing' || !site.glyph || !placeGlyph(site, site.glyph)) {
				toIdle(site, 400);
				continue;
			}
			if (site.phase === 'assembling') beginHold(site, false);
		}
		if (!firstFrame) return;
		draw();
	};

	const loop = (now: number) => {
		raf = 0;
		timer = null;
		if (destroyed) return;
		const dt = lastNow ? Math.min(MAX_DT, now - lastNow) : 16;
		lastNow = now;

		if (++frameCount % EXCLUSION_REFRESH_FRAMES === 0) cachedExclusion = readCopyExclusion();
		step(dt);
		draw();

		if (!firstFrame) {
			firstFrame = true;
			onFirstFrame?.();
		}
		schedule();
	};

	const schedule = () => {
		if (destroyed || raf || timer) return;
		if (!visible) {
			lastNow = 0;
			return;
		}
		// Reduced motion: nothing moves, so only repaint occasionally to follow theme changes.
		if (reducedMotion) timer = setTimeout(() => loop(performance.now()), 500);
		else raf = requestAnimationFrame(loop);
	};

	const onPointerMove = (e: PointerEvent) => {
		const r = host.getBoundingClientRect();
		const sx = e.clientX - r.left;
		const sy = e.clientY - r.top;
		if (sx < 0 || sy < 0 || sx > viewW || sy > viewH) return;
		const { gx, gy } = screenToGrid(sx, sy);
		const key = gy * cols + gx;
		if (key === lastPointerCell) return;
		lastPointerCell = key;
		addHeat(gx, gy, 0.16);
	};

	let resizeQueued = false;
	const ro = new ResizeObserver(() => {
		if (resizeQueued) return;
		resizeQueued = true;
		requestAnimationFrame(() => {
			resizeQueued = false;
			if (!destroyed) resize();
		});
	});
	ro.observe(host);
	const copy = findCopy();
	if (copy instanceof HTMLElement) ro.observe(copy);

	const io = new IntersectionObserver(
		(entries) => {
			visible = entries.some((e) => e.isIntersecting);
			schedule();
		},
		{ rootMargin: '64px' }
	);
	io.observe(host);

	const offPointer =
		tune.pointer && finePointer && !reducedMotion
			? on(window, 'pointermove', onPointerMove, { passive: true })
			: null;

	resize();
	schedule();

	return {
		destroy() {
			destroyed = true;
			cancelAnimationFrame(raf);
			if (timer) clearTimeout(timer);
			ro.disconnect();
			io.disconnect();
			offPointer?.();
		}
	};
}

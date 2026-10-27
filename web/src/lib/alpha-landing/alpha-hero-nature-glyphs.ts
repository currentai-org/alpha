/**
 * Nature vignettes for the hero field — small scenes (pines, a sunrise, a sprout…) described as
 * simple vector shapes, drawn UPRIGHT, and rasterised onto the 45° lattice at runtime.
 *
 * Scene space is screen-oriented: x ∈ [-50, 50] left→right, y ∈ [-40, 40] top→bottom. Each lattice
 * unit is a diamond; one is lit when its centre falls inside a shape (later shapes win, `clear` cuts
 * holes). The lattice's own geometry favours diagonals, so the vocabulary leans on them — mountains,
 * pine tiers, birds, rain — and those read crisply; long horizontals come out gently stepped.
 */

export type GlyphTone = 'accent' | 'ink';

/** One lit unit, as a lattice offset from the glyph's anchor. */
export type GlyphCell = { a: number; b: number; tone: GlyphTone };

export type NatureGlyph = {
	id: string;
	/** Rasterised frames; frame 0 is the one pieces assemble into. */
	frames: readonly (readonly GlyphCell[])[];
	/** Milliseconds per frame while the glyph holds (single-frame glyphs ignore it). */
	frameMs: number;
	/** Chebyshev radius of the glyph in lattice units. */
	radius: number;
};

/** Diamonds across the 100-unit scene width — sets how much screen a vignette takes. */
export const NATURE_GLYPH_DIAMONDS = 18;

type Tone = GlyphTone | 'clear';
type Hit = (x: number, y: number) => boolean;
type Shape = { tone: Tone; hit: Hit };

// ── Shape vocabulary ──────────────────────────────────────────────────────────

const circle = (tone: Tone, cx: number, cy: number, r: number): Shape => ({
	tone,
	hit: (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r
});

const ellipse = (tone: Tone, cx: number, cy: number, rx: number, ry: number, rotDeg = 0): Shape => {
	const t = (rotDeg * Math.PI) / 180;
	const c = Math.cos(t);
	const s = Math.sin(t);
	return {
		tone,
		hit: (x, y) => {
			const dx = x - cx;
			const dy = y - cy;
			const u = dx * c + dy * s;
			const v = -dx * s + dy * c;
			return (u / rx) ** 2 + (v / ry) ** 2 <= 1;
		}
	};
};

const rect = (tone: Tone, x0: number, y0: number, x1: number, y1: number): Shape => ({
	tone,
	hit: (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1
});

const tri = (
	tone: Tone,
	[ax, ay]: [number, number],
	[bx, by]: [number, number],
	[cx, cy]: [number, number]
): Shape => {
	const sign = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
		(px - rx) * (qy - ry) - (qx - rx) * (py - ry);
	return {
		tone,
		hit: (x, y) => {
			const d1 = sign(x, y, ax, ay, bx, by);
			const d2 = sign(x, y, bx, by, cx, cy);
			const d3 = sign(x, y, cx, cy, ax, ay);
			const neg = d1 < 0 || d2 < 0 || d3 < 0;
			const pos = d1 > 0 || d2 > 0 || d3 > 0;
			return !(neg && pos);
		}
	};
};

/** A thick polyline (capsule segments). */
const stroke = (tone: Tone, width: number, ...pts: [number, number][]): Shape => ({
	tone,
	hit: (x, y) => {
		for (let i = 0; i < pts.length - 1; i++) {
			const [x0, y0] = pts[i];
			const [x1, y1] = pts[i + 1];
			const dx = x1 - x0;
			const dy = y1 - y0;
			const len2 = dx * dx + dy * dy || 1;
			const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2));
			if ((x - x0 - t * dx) ** 2 + (y - y0 - t * dy) ** 2 <= (width / 2) ** 2) return true;
		}
		return false;
	}
});

const where = (shape: Shape, keep: Hit): Shape => ({
	tone: shape.tone,
	hit: (x, y) => keep(x, y) && shape.hit(x, y)
});

const pine = (tone: Tone, cx: number, base: number, h: number): Shape[] => {
	const w = h * 0.62;
	return [
		tri(tone, [cx, base - h], [cx - w * 0.36, base - h * 0.58], [cx + w * 0.36, base - h * 0.58]),
		tri(
			tone,
			[cx, base - h * 0.78],
			[cx - w * 0.44, base - h * 0.3],
			[cx + w * 0.44, base - h * 0.3]
		),
		tri(
			tone,
			[cx, base - h * 0.55],
			[cx - w * 0.5, base - h * 0.06],
			[cx + w * 0.5, base - h * 0.06]
		),
		rect('ink', cx - 3, base - h * 0.08, cx + 3, base + 2)
	];
};

const star = (tone: Tone, cx: number, cy: number, r: number): Shape[] => [
	stroke(tone, 2.6, [cx - r, cy], [cx + r, cy]),
	stroke(tone, 2.6, [cx, cy - r], [cx, cy + r])
];

// ── Scenes ────────────────────────────────────────────────────────────────────

type Scene = { id: string; frames: number; frameMs?: number; shapes: (frame: number) => Shape[] };

const SCENES: Scene[] = [
	{
		id: 'pines',
		frames: 1,
		shapes: () => [
			rect('ink', -48, 30, 48, 36),
			...pine('accent', -20, 30, 64),
			...pine('accent', 12, 30, 48),
			...pine('accent', 36, 30, 34)
		]
	},
	{
		id: 'sunrise',
		frames: 1,
		shapes: () => [
			circle('accent', 20, -16, 13),
			tri('ink', [-50, 34], [-14, -22], [22, 34]),
			tri('ink', [2, 34], [28, 0], [52, 34]),
			tri('accent', [-14, -22], [-23, -9], [-5, -9])
		]
	},
	{
		id: 'sea',
		frames: 3,
		frameMs: 1600,
		shapes: (f) => {
			const phase = (f * Math.PI * 2) / 3;
			const wave = (y0: number, amp: number, k: number, ph: number, width: number): Shape => ({
				tone: 'ink',
				hit: (x, y) => Math.abs(y - (y0 + amp * Math.sin(x / k + ph))) <= width
			});
			return [
				where(circle('accent', 0, 4, 20), (_x, y) => y <= 6),
				where(wave(10, 3, 7, phase, 2.2), (x) => Math.abs(x) <= 48),
				where(wave(22, 3.5, 8, -phase + 1, 2.4), (x) => Math.abs(x) <= 44),
				where(wave(33, 3, 9, phase + 2, 2.2), (x) => Math.abs(x) <= 38)
			];
		}
	},
	{
		id: 'birds',
		frames: 2,
		frameMs: 700,
		shapes: (f) => {
			const lift = f === 0 ? -6 : 3;
			const bird = (cx: number, cy: number, s: number): Shape =>
				stroke(
					'accent',
					3.2,
					[cx - 12 * s, cy + lift * s],
					[cx, cy + 5 * s],
					[cx + 12 * s, cy + lift * s]
				);
			return [
				ellipse('ink', -22, 44, 44, 20),
				ellipse('ink', 30, 48, 38, 18),
				bird(-14, -20, 1),
				bird(16, -30, 0.75),
				bird(26, -6, 0.6)
			];
		}
	},
	{
		id: 'tree',
		frames: 1,
		shapes: () => [
			rect('ink', -34, 30, 34, 35),
			rect('ink', -4, 2, 4, 32),
			stroke('ink', 5, [0, 12], [-10, 2]),
			circle('accent', 0, -14, 19),
			circle('accent', -16, -2, 13),
			circle('accent', 16, -2, 13)
		]
	},
	{
		id: 'mushrooms',
		frames: 1,
		shapes: () => [
			rect('ink', -44, 30, 44, 35),
			rect('ink', -14, -2, -2, 30),
			where(ellipse('accent', -8, 0, 24, 20), (_x, y) => y <= 0),
			circle('clear', -16, -10, 3.4),
			circle('clear', 0, -7, 2.8),
			rect('ink', 19, 16, 25, 30),
			where(ellipse('accent', 22, 17, 13, 11), (_x, y) => y <= 17)
		]
	},
	{
		id: 'moon',
		frames: 2,
		frameMs: 1600,
		shapes: (f) => [
			circle('accent', -12, -2, 24),
			circle('clear', 0, -10, 21),
			...star('accent', 24, -22, 5),
			...star('accent', 34, 12, 4),
			...(f === 0 ? star('accent', 12, 24, 3.5) : [])
		]
	},
	{
		id: 'sprout',
		frames: 2,
		frameMs: 2200,
		shapes: (f) => {
			const tilt = f === 0 ? 0 : 6;
			return [
				ellipse('ink', 0, 32, 26, 6),
				stroke('ink', 6, [0, 30], [0, 0], [2, -6]),
				ellipse('accent', -13, -12, 14, 9, -34 + tilt),
				ellipse('accent', 14, -16, 14, 9, 34 + tilt)
			];
		}
	},
	{
		id: 'flower',
		frames: 1,
		shapes: () => {
			const petals: Shape[] = [];
			for (let i = 0; i < 6; i++) {
				const t = (i / 6) * Math.PI * 2 - Math.PI / 2;
				petals.push(circle('accent', Math.cos(t) * 10, -14 + Math.sin(t) * 10, 7.5));
			}
			return [
				rect('ink', -36, 31, 36, 36),
				stroke('ink', 6, [0, -6], [0, 32]),
				ellipse('accent', 10, 16, 10, 4.5, -30),
				ellipse('accent', -10, 22, 9, 4, 30),
				...petals,
				circle('ink', 0, -14, 5)
			];
		}
	},
	{
		id: 'rain',
		frames: 3,
		frameMs: 500,
		shapes: (f) => {
			const drops: Shape[] = [];
			for (let i = 0; i < 6; i++) {
				const x = -24 + i * 10;
				const y = 12 + ((i * 7 + f * 8) % 24);
				drops.push(stroke('ink', 2.6, [x, y], [x - 4, y + 7]));
			}
			return [
				circle('accent', -12, -12, 13),
				circle('accent', 6, -18, 15),
				circle('accent', 20, -8, 11),
				rect('accent', -26, -12, 30, 2),
				...drops
			];
		}
	},
	{
		id: 'fish',
		frames: 2,
		frameMs: 900,
		shapes: (f) => {
			const flick = f === 0 ? 0 : 5;
			return [
				ellipse('accent', -6, 0, 26, 14),
				tri('accent', [16, 0], [34, -14 + flick], [34, 14 + flick]),
				circle('clear', -20, -3, 3),
				circle('ink', -36, -20, 3),
				circle('ink', -42, -30, 2.4)
			];
		}
	}
];

// ── Rasterising ───────────────────────────────────────────────────────────────

/** Scene units per lattice-unit step (half the horizontal distance between diamond centres). */
const STEP = 100 / (2 * NATURE_GLYPH_DIAMONDS);

function rasterize(shapes: Shape[]): GlyphCell[] {
	const cells: GlyphCell[] = [];
	const reach = Math.ceil(50 / STEP);
	for (let a = -reach; a <= reach; a++) {
		for (let b = -reach; b <= reach; b++) {
			// Lattice +a is screen down-right, +b is screen down-left.
			const x = (a - b) * STEP;
			const y = (a + b) * STEP;
			if (Math.abs(x) > 50 || Math.abs(y) > 40) continue;
			let tone: Tone | null = null;
			for (const s of shapes) if (s.hit(x, y)) tone = s.tone;
			if (tone && tone !== 'clear') cells.push({ a, b, tone });
		}
	}
	return cells;
}

function build(scene: Scene): NatureGlyph {
	const frames = Array.from({ length: scene.frames }, (_, f) => rasterize(scene.shapes(f)));
	let radius = 0;
	for (const f of frames) {
		for (const c of f) radius = Math.max(radius, Math.abs(c.a), Math.abs(c.b));
	}
	return { id: scene.id, frames, frameMs: scene.frameMs ?? 1400, radius };
}

let built: NatureGlyph[] | null = null;

/** Rasterised lazily on first use, so importing this module costs nothing. */
export function natureGlyphs(): readonly NatureGlyph[] {
	built ??= SCENES.map(build);
	return built;
}

export function shuffledNatureGlyphs(): NatureGlyph[] {
	const list = [...natureGlyphs()];
	for (let i = list.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[list[i], list[j]] = [list[j], list[i]];
	}
	return list;
}

export function glyphCells(g: NatureGlyph, frame: number): readonly GlyphCell[] {
	const n = g.frames.length;
	return g.frames[((frame % n) + n) % n];
}

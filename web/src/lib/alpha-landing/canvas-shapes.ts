/** Small canvas and easing helpers shared by the new-chat backdrop and Potluck Run. */

/** An octagon centred on (x, y) with half-width r, the pattern sheet's dot shape, as a path. */
export function octagonPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	r: number,
	cut = 0.42
) {
	const c = r * cut;
	ctx.moveTo(x - r + c, y - r);
	ctx.lineTo(x + r - c, y - r);
	ctx.lineTo(x + r, y - r + c);
	ctx.lineTo(x + r, y + r - c);
	ctx.lineTo(x + r - c, y + r);
	ctx.lineTo(x - r + c, y + r);
	ctx.lineTo(x - r, y + r - c);
	ctx.lineTo(x - r, y - r + c);
	ctx.closePath();
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export const smoothstep = (a: number, b: number, v: number) => {
	const t = clamp01((v - a) / (b - a));
	return t * t * (3 - 2 * t);
};

/** Overshoots a little and settles: a piece dropping into place. */
export const easeOutBack = (v: number) => 1 + 2.4 * (v - 1) ** 3 + 1.4 * (v - 1) ** 2;

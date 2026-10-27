/**
 * OKLCH colour math — sRGB ⇄ OKLab ⇄ OKLCH, gamut mapping, WCAG contrast.
 *
 * Zero dependencies and isomorphic: the token generator (Node), the drift test (Vitest) and the
 * runtime theme playground (browser) all run the same code, so a colour computed for
 * `generated/tokens.css` is bit-for-bit the colour the playground previews.
 *
 * Matrices are Björn Ottosson's reference OKLab constants.
 */

export interface Oklch {
	/** Perceptual lightness, 0–1. */
	l: number;
	/** Chroma, 0–~0.37 inside sRGB. */
	c: number;
	/** Hue angle in degrees, 0–360. */
	h: number;
	/** Alpha, 0–1. Omitted means opaque. */
	alpha?: number;
}

type Rgb = [number, number, number];

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function srgbToLinear(c: number): number {
	return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
	return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Parse `#rgb`, `#rrggbb` or `#rrggbbaa` into 0–1 sRGB channels. */
export function parseHex(hex: string): { rgb: Rgb; alpha: number } {
	let h = hex.trim().replace(/^#/, '');
	if (h.length === 3 || h.length === 4) h = [...h].map((ch) => ch + ch).join('');
	if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`Invalid hex colour: ${hex}`);
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
	return { rgb: [n(0), n(2), n(4)], alpha: h.length === 8 ? n(6) : 1 };
}

function linearRgbToOklch([r, g, b]: Rgb): Oklch {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const c = Math.sqrt(A * A + B * B);
	let h = (Math.atan2(B, A) * 180) / Math.PI;
	if (h < 0) h += 360;
	// Achromatic colours have no meaningful hue; pin to 0 so output is stable.
	return { l: L, c: c < 1e-4 ? 0 : c, h: c < 1e-4 ? 0 : h };
}

function oklchToLinearRgb({ l, c, h }: Oklch): Rgb {
	const hr = (h * Math.PI) / 180;
	const A = c * Math.cos(hr);
	const B = c * Math.sin(hr);
	const l_ = l + 0.3963377774 * A + 0.2158037573 * B;
	const m_ = l - 0.1055613458 * A - 0.0638541728 * B;
	const s_ = l - 0.0894841775 * A - 1.291485548 * B;
	const L = l_ ** 3;
	const M = m_ ** 3;
	const S = s_ ** 3;
	return [
		4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
		-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
		-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
	];
}

export function hexToOklch(hex: string): Oklch {
	const { rgb, alpha } = parseHex(hex);
	const out = linearRgbToOklch(rgb.map(srgbToLinear) as Rgb);
	return alpha < 1 ? { ...out, alpha } : out;
}

const inGamut = (rgb: Rgb) => rgb.every((v) => v >= -1e-5 && v <= 1 + 1e-5);

/**
 * Map an OKLCH colour into sRGB by reducing chroma at constant lightness and hue (CSS Color 4's
 * recommended strategy, binary-search variant). Lightness is clamped first.
 */
export function toGamut(color: Oklch): Oklch {
	const l = clamp01(color.l);
	const base = { ...color, l };
	if (inGamut(oklchToLinearRgb(base))) return base;
	let lo = 0;
	let hi = color.c;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklchToLinearRgb({ ...base, c: mid }))) lo = mid;
		else hi = mid;
	}
	return { ...base, c: lo };
}

export function oklchToHex(color: Oklch): string {
	const rgb = oklchToLinearRgb(toGamut(color)).map((v) =>
		Math.round(clamp01(linearToSrgb(clamp01(v))) * 255)
	);
	return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const round = (n: number, digits: number) => {
	const f = 10 ** digits;
	return Math.round(n * f) / f;
};

/** Serialise as a CSS `oklch()` string, e.g. `oklch(0.218 0 0)` / `oklch(1 0 0 / 0.3)`. */
export function formatOklch(color: Oklch): string {
	const { l, c, h, alpha } = toGamut(color);
	const body = `${round(l, 3)} ${round(c, 3)} ${round(c === 0 ? 0 : h, 1)}`;
	return alpha !== undefined && alpha < 1
		? `oklch(${body} / ${round(alpha, 3)})`
		: `oklch(${body})`;
}

/** Composite a translucent colour over an opaque backdrop (in linear sRGB — what the GPU does). */
export function composite(top: Oklch, backdrop: Oklch): Oklch {
	const a = top.alpha ?? 1;
	if (a >= 1) return top;
	const t = oklchToLinearRgb(toGamut(top));
	const b = oklchToLinearRgb(toGamut(backdrop));
	return linearRgbToOklch(t.map((v, i) => v * a + b[i] * (1 - a)) as Rgb);
}

/** Interpolate two colours in OKLab (perceptually even, no hue swing through grey). */
export function mix(a: Oklch, b: Oklch, t: number): Oklch {
	const toLab = ({ l, c, h }: Oklch) => {
		const hr = (h * Math.PI) / 180;
		return [l, c * Math.cos(hr), c * Math.sin(hr)];
	};
	const [l1, a1, b1] = toLab(a);
	const [l2, a2, b2] = toLab(b);
	const L = l1 + (l2 - l1) * t;
	const A = a1 + (a2 - a1) * t;
	const B = b1 + (b2 - b1) * t;
	const c = Math.sqrt(A * A + B * B);
	let h = (Math.atan2(B, A) * 180) / Math.PI;
	if (h < 0) h += 360;
	return { l: L, c: c < 1e-4 ? 0 : c, h: c < 1e-4 ? 0 : h };
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(color: Oklch): number {
	const [r, g, b] = oklchToLinearRgb(toGamut(color)).map(clamp01);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1–21. Translucent `fg` is composited over `bg` first. */
export function contrast(fg: Oklch, bg: Oklch): number {
	const f = luminance(composite(fg, bg));
	const b = luminance(bg);
	return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
}

/**
 * Move `seed` along the lightness axis (keeping hue and chroma) until it reaches `minRatio`
 * against `bg`. Returns the closest-to-seed colour that passes; falls back to black/white.
 */
export function solveContrast(seed: Oklch, bg: Oklch, minRatio: number): Oklch {
	if (contrast(seed, bg) >= minRatio) return seed;
	const goLighter = luminance(bg) < 0.18;
	let lo = goLighter ? seed.l : 0;
	let hi = goLighter ? 1 : seed.l;
	let best: Oklch | null = null;
	for (let i = 0; i < 32; i++) {
		const mid = (lo + hi) / 2;
		const candidate = toGamut({ ...seed, l: mid });
		if (contrast(candidate, bg) >= minRatio) {
			best = candidate;
			if (goLighter) hi = mid;
			else lo = mid;
		} else if (goLighter) lo = mid;
		else hi = mid;
	}
	return best ?? { l: goLighter ? 1 : 0, c: 0, h: 0 };
}

export const withAlpha = (color: Oklch, alpha: number): Oklch => ({ ...color, alpha });
export const shiftL = (color: Oklch, delta: number): Oklch => ({
	...color,
	l: clamp01(color.l + delta)
});

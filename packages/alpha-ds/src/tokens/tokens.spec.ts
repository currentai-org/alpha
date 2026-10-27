import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCss, buildDtcg, buildTailwind, tokenManifest } from './build.ts';
import { CONTRAST_TARGETS, deriveMode, SEMANTIC_TOKENS, type Mode } from './color/derive.ts';
import { contrast, formatOklch, hexToOklch, oklchToHex, solveContrast } from './color/oklch.ts';
import { themes } from './themes.ts';

const generated = (name: string) =>
	readFileSync(resolve(import.meta.dirname, 'generated', name), 'utf8');

describe('generated token files', () => {
	it('tokens.css matches its TS sources (fails when someone edits a seed without `pnpm ds:tokens`)', () => {
		expect(generated('tokens.css')).toBe(buildCss());
	});
	it('tailwind.css matches its TS sources', () => {
		expect(generated('tailwind.css')).toBe(buildTailwind());
	});
	it('tokens.json (DTCG) matches its TS sources', () => {
		expect(JSON.parse(generated('tokens.json'))).toEqual(buildDtcg());
	});
	it('declares every semantic token exactly once in the :root block', () => {
		const css = buildCss();
		for (const { name } of SEMANTIC_TOKENS) {
			expect(
				css.match(new RegExp(`--ds-${name}: light-dark\\(`, 'g'))?.length ?? 0
			).toBeGreaterThanOrEqual(1);
		}
	});
	it('the manifest has no duplicate names', () => {
		const m = tokenManifest();
		expect(new Set(m).size).toBe(m.length);
	});
});

describe('OKLCH math', () => {
	it('round-trips sRGB hex through OKLCH', () => {
		for (const hex of ['#181818', '#f88376', '#0b252f', '#ffffff', '#000000', '#ea3729']) {
			expect(oklchToHex(hexToOklch(hex))).toBe(hex);
		}
	});
	it('matches the WCAG reference ratio for black on white (21:1)', () => {
		expect(contrast(hexToOklch('#000000'), hexToOklch('#ffffff'))).toBeCloseTo(21, 1);
	});
	it('solveContrast reaches the target or reports the extreme', () => {
		const bg = hexToOklch('#181818');
		const solved = solveContrast(hexToOklch('#333333'), bg, 4.5);
		expect(contrast(solved, bg)).toBeGreaterThanOrEqual(4.5);
	});
	it('formats valid CSS oklch() strings', () => {
		expect(formatOklch(hexToOklch('#ffffff'))).toBe('oklch(1 0 0)');
		expect(formatOklch({ l: 1, c: 0, h: 0, alpha: 0.3 })).toBe('oklch(1 0 0 / 0.3)');
	});
});

describe.each(
	themes.flatMap((t) => (['light', 'dark'] as Mode[]).map((m) => [t.id, m, t] as const))
)('theme %s / %s — contrast contract', (_id, mode, theme) => {
	const p = deriveMode(theme, mode);
	const tiers = [p['bg-1'], p['bg-2'], p['bg-3']];

	it('derives every semantic token', () => {
		for (const { name } of SEMANTIC_TOKENS) expect(p[name], name).toBeDefined();
	});
	it(`Text 1 ≥ ${CONTRAST_TARGETS['fg-1']}:1 on all three backgrounds`, () => {
		for (const bg of tiers)
			expect(contrast(p['fg-1'], bg)).toBeGreaterThanOrEqual(CONTRAST_TARGETS['fg-1']);
	});
	it(`Text 2 ≥ ${CONTRAST_TARGETS['fg-2']}:1 on all three backgrounds`, () => {
		for (const bg of tiers)
			expect(contrast(p['fg-2'], bg)).toBeGreaterThanOrEqual(CONTRAST_TARGETS['fg-2']);
	});
	it(`Text 3 ≥ ${CONTRAST_TARGETS['fg-3']}:1 on Background 1 and 2 (readable, not decorative)`, () => {
		for (const bg of tiers.slice(0, 2))
			expect(contrast(p['fg-3'], bg)).toBeGreaterThanOrEqual(CONTRAST_TARGETS['fg-3']);
	});
	it('keeps the text hierarchy ordered (Text 1 > Text 2 > Text 3 in contrast)', () => {
		const c = (k: string) => contrast(p[k], p['bg-1']);
		expect(c('fg-1')).toBeGreaterThan(c('fg-2'));
		expect(c('fg-2')).toBeGreaterThan(c('fg-3'));
	});
	it('keeps the elevation rule: Background 2 darker than 1, Background 3 lighter', () => {
		expect(p['bg-2'].l).toBeLessThan(p['bg-1'].l);
		expect(p['bg-3'].l).toBeGreaterThan(p['bg-1'].l);
	});
	it('accent/status text variants are AA on every background', () => {
		for (const k of ['accent-1-text', 'accent-2-text', 'positive-text', 'caution-text']) {
			for (const bg of tiers)
				expect(contrast(p[k], bg), k).toBeGreaterThanOrEqual(CONTRAST_TARGETS['accent-text']);
		}
	});
	it('the glyph on an accent fill is legible', () => {
		expect(contrast(p['fg-on-accent'], p['accent-1'])).toBeGreaterThanOrEqual(
			CONTRAST_TARGETS['on-accent']
		);
	});
	it('text on chrome and on the inverse surface is legible', () => {
		expect(contrast(p['fg-on-chrome'], p['bg-chrome'])).toBeGreaterThanOrEqual(7);
		expect(contrast(p['fg-inverse'], p['bg-inverse'])).toBeGreaterThanOrEqual(7);
	});
	it('the focus ring is visible against Background 1', () => {
		expect(contrast(p.focus, p['bg-1'])).toBeGreaterThanOrEqual(CONTRAST_TARGETS.focus);
	});
	it('borders step up in visibility (Border 1 < 2 < 3)', () => {
		const c = (k: string) => contrast(p[k], p['bg-1']);
		expect(c('line-1')).toBeLessThan(c('line-2'));
		expect(c('line-2')).toBeLessThan(c('line-3'));
	});
});

describe('CF spec fidelity (dark window)', () => {
	const alpha = themes.find((t) => t.id === 'alpha')!;
	const p = deriveMode(alpha, 'dark');
	it('Background 1/2/3 are the spec hexes #181818 / #121212 / #2F2F2F (±1 per channel)', () => {
		const near = (a: string, b: string) =>
			[1, 3, 5].every(
				(i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1
			);
		expect(near(oklchToHex(p['bg-1']), '#181818')).toBe(true);
		expect(near(oklchToHex(p['bg-2']), '#121212')).toBe(true);
		expect(near(oklchToHex(p['bg-3']), '#2f2f2f')).toBe(true);
	});
	it('Accent 1 is ≈ #F88476 and Accent 2 ≈ #EA3729', () => {
		expect(oklchToHex(p['accent-1'])).toBe('#f88376');
		expect(oklchToHex(p['accent-2'])).toBe('#ea3729');
	});
	it('Borders are white at 10 / 30 / 50%', () => {
		expect([p['line-1'].alpha, p['line-2'].alpha, p['line-3'].alpha]).toEqual([0.1, 0.3, 0.5]);
	});
});

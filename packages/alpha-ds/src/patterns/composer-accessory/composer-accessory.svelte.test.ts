import type { CDPSession } from '@vitest/browser-playwright';
import { cdp, page } from 'vitest/browser';
import { cleanup, render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Harness from './composer-accessory.harness.svelte';
import { cubicBezier } from '../../internal/motion.ts';

// The chat's composer band is docked to the bottom of the window, so a panel opening above the
// composer raises the top edge of the whole stack (`[data-composer-accessory]`). These read that edge
// across each transition: as one panel replaces another it has to travel from where it was to where
// it lands, and never past either. An outgoing panel that stays in flow at full height beside the
// incoming one (what a bare fade does) puts the edge above both for the length of the fade.

const SLACK_PX = 3; // borders snap to whole device pixels as a panel collapses

const stackTop = () =>
	document.querySelector('[data-composer-accessory]')!.getBoundingClientRect().top;
const panelCount = () => document.querySelectorAll('[data-accessory-panel]').length;
const pill = (name: string) => page.getByRole('button', { name, exact: true });
// vitest types `cdp()` as an empty interface; the Playwright provider's own type has `send`.
const session = () => cdp() as unknown as CDPSession;

/**
 * Runs `act`, catches the panels' eased transitions as Svelte starts them (`transitions` of them: one
 * to open or close, two to switch), and reads `measure()` with them paused at eleven evenly spaced
 * points from start to end. Seeking a paused animation puts every sample mid-flight however slow the
 * runner is; sampling live animation frames can miss a whole close on a loaded CI runner (CUR-2462).
 * A panel that snaps starts no transition, so the wait below is what fails.
 */
async function scrub(measure: () => number, act: () => Promise<unknown>, transitions: number) {
	const caught: Animation[] = [];
	const animate = Element.prototype.animate;
	Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
		const animation = animate.apply(this, args);
		// Svelte opens each transition with a zero-length placeholder; only the real one has a duration.
		if (
			this.matches('[data-accessory-panel]') &&
			Number(animation.effect?.getTiming().duration) > 0
		) {
			animation.pause();
			caught.push(animation);
		}
		return animation;
	};
	try {
		await act();
		await expect
			.poll(() => caught.length, { message: 'the panel snapped: no eased transition started' })
			.toBe(transitions);
	} finally {
		Element.prototype.animate = animate;
	}
	const seen: number[] = [];
	for (let step = 0; step <= 10; step++) {
		for (const animation of caught) {
			animation.currentTime = (Number(animation.effect!.getTiming().duration) * step) / 10;
		}
		seen.push(measure());
	}
	for (const animation of caught) animation.finish();
	return seen;
}

/** Reads `measure()` on every animation frame while `act` runs, then for `settleMs` after it. */
async function frames(measure: () => number, act: () => Promise<unknown>, settleMs = 500) {
	const seen: number[] = [];
	let running = true;
	const tick = () => {
		if (!running) return;
		seen.push(measure());
		requestAnimationFrame(tick);
	};
	tick();
	await act();
	await new Promise((resolve) => setTimeout(resolve, settleMs));
	running = false;
	return seen;
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Waits for the transition to finish: `panels` panels in the DOM and the stack's edge holding still. */
async function settled(panels: number) {
	await expect.poll(panelCount, { message: 'the outgoing panel never left the DOM' }).toBe(panels);
	let last = Number.NaN;
	let still = 0;
	for (let frame = 0; still < 6; frame++) {
		if (frame > 240) throw new Error('the stack never stopped moving');
		await nextFrame();
		const y = stackTop();
		still = y === last ? still + 1 : 0;
		last = y;
	}
}

beforeEach(async () => {
	// Below md the panels become bottom sheets, which is not what this pins.
	await page.viewport(1280, 900);
	render(Harness);
});

afterEach(async () => {
	cleanup();
	await session().send('Emulation.setEmulatedMedia', { features: [] });
});

describe('ComposerAccessory panel switching', () => {
	it('moves the stack only from where it was to where it lands — never past either — when a taller panel replaces a shorter one', async () => {
		await pill('Short').click();
		await settled(1);
		const from = stackTop();

		const seen = await scrub(stackTop, () => pill('Tall').click(), 2);
		await settled(1);
		const to = stackTop();

		expect(to, 'the taller panel should raise the stack').toBeLessThan(from - 100);
		expect(
			Math.min(...seen),
			'the stack rose past the incoming panel: both panels stacked'
		).toBeGreaterThanOrEqual(to - SLACK_PX);
		expect(Math.max(...seen)).toBeLessThanOrEqual(from + SLACK_PX);
		expect(
			seen.filter((y) => y < from - SLACK_PX && y > to + SLACK_PX).length,
			'the stack snapped instead of easing'
		).toBeGreaterThan(0);
	});

	it('moves the stack only from where it was to where it lands — never past either — when a shorter panel replaces a taller one', async () => {
		await pill('Tall').click();
		await settled(1);
		const from = stackTop();

		const seen = await scrub(stackTop, () => pill('Short').click(), 2);
		await settled(1);
		const to = stackTop();

		expect(to, 'the shorter panel should lower the stack').toBeGreaterThan(from + 100);
		expect(
			Math.min(...seen),
			'the stack rose past where it started: both panels stacked'
		).toBeGreaterThanOrEqual(from - SLACK_PX);
		expect(Math.max(...seen)).toBeLessThanOrEqual(to + SLACK_PX);
		expect(
			seen.filter((y) => y > from + SLACK_PX && y < to - SLACK_PX).length,
			'the stack snapped instead of easing'
		).toBeGreaterThan(0);
	});

	it('eases the stack open and shut rather than snapping it', async () => {
		const closed = stackTop();

		const opening = await scrub(stackTop, () => pill('Tall').click(), 1);
		await settled(1);
		const open = stackTop();
		expect(open).toBeLessThan(closed - 100);
		expect(Math.min(...opening)).toBeGreaterThanOrEqual(open - SLACK_PX);
		expect(
			opening.filter((y) => y < closed - SLACK_PX && y > open + SLACK_PX).length,
			'opening snapped'
		).toBeGreaterThan(0);

		const closing = await scrub(stackTop, () => pill('Tall').click(), 1);
		await settled(0);
		expect(Math.max(...closing)).toBeLessThanOrEqual(closed + SLACK_PX);
		expect(
			closing.filter((y) => y > open + SLACK_PX && y < closed - SLACK_PX).length,
			'closing snapped'
		).toBeGreaterThan(0);
		expect(stackTop()).toBeCloseTo(closed, 0);
	});

	it('swaps instantly, never holding two panels at once, when the person asks for reduced motion', async () => {
		await session().send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
		});
		await pill('Short').click();
		await settled(1);

		const counts = await frames(panelCount, () => pill('Tall').click(), 300);

		expect(Math.max(...counts)).toBe(1);
		expect(panelCount()).toBe(1);
	});
});

describe('cubicBezier', () => {
	// The easing has to match what CSS does with the same curve, or a JS transition drifts from the
	// CSS ones it sits beside. The browser's own evaluation of the token's curve is the reference.
	const points = [
		[0.2, 0, 0, 1],
		[0.4, 0, 1, 1]
	] as const;

	for (const curve of points) {
		it(`agrees with the browser on cubic-bezier(${curve.join(', ')})`, () => {
			const probe = document.body.appendChild(document.createElement('div'));
			const animation = probe.animate([{ opacity: 0 }, { opacity: 1 }], {
				duration: 1000,
				fill: 'both',
				easing: `cubic-bezier(${curve.join(', ')})`
			});
			animation.pause();
			const [x1, y1, x2, y2] = curve;
			const ease = cubicBezier(x1, y1, x2, y2);
			for (const t of [0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95]) {
				animation.currentTime = t * 1000;
				const reference = animation.effect!.getComputedTiming().progress!;
				expect(ease(t), `at t=${t}`).toBeCloseTo(reference, 3);
			}
			animation.cancel();
			probe.remove();
		});
	}

	it('runs from 0 to 1 and never steps backwards', () => {
		const ease = cubicBezier(0.2, 0, 0, 1);
		expect(ease(0)).toBe(0);
		expect(ease(1)).toBe(1);
		let last = 0;
		for (let i = 1; i <= 100; i++) {
			const y = ease(i / 100);
			expect(y).toBeGreaterThanOrEqual(last);
			last = y;
		}
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/analytics', () => ({ trackEvent: vi.fn() }));

import { tour } from './tour.svelte';
import { TOUR_STEPS } from './steps';

// A page where each selector in `present` matches one laid-out element.
function page(present: string[]) {
	const laidOut = { getBoundingClientRect: () => ({ width: 40, height: 20 }) };
	vi.stubGlobal('document', {
		querySelectorAll: (selector: string) => (present.includes(selector) ? [laidOut] : [])
	});
}

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k)
});

const all = TOUR_STEPS.map((s) => s.selector);

beforeEach(() => {
	if (tour.active) tour.finish('dismissed');
	tour.hint = false;
	store.clear();
});

describe('the guided tour visits only the features on screen, and a skipped welcome points at it until found', () => {
	it('leaves out a stop whose element is not on the page (a flag is off)', () => {
		page(all.filter((s) => !s.includes('xray')));
		expect(tour.start('menu')).toBe(true);
		expect(tour.steps.map((s) => s.id)).not.toContain('xray');
		expect(tour.steps).toHaveLength(TOUR_STEPS.length - 1);
	});

	it('does not open at all when none of its features is on screen', () => {
		page([]);
		expect(tour.start('menu')).toBe(false);
		expect(tour.active).toBe(false);
	});

	it('walks forward and back, and closes after the last stop', () => {
		page(all);
		tour.start('menu');
		tour.next();
		expect(tour.step?.id).toBe(TOUR_STEPS[1].id);
		tour.back();
		expect(tour.step?.id).toBe(TOUR_STEPS[0].id);
		for (let i = 0; i < TOUR_STEPS.length; i++) tour.next();
		expect(tour.active).toBe(false);
	});

	it('a "try it" pauses on that stop, and resuming goes on to the next one', () => {
		page(all);
		tour.start('menu');
		tour.next();
		tour.pause();
		expect(tour.active && tour.paused).toBe(true);
		tour.resume();
		expect(tour.paused).toBe(false);
		expect(tour.step?.id).toBe(TOUR_STEPS[2].id);
	});

	it("a stop whose element disappears mid-tour is dropped, so the count stays true", () => {
		page(all);
		tour.start('menu');
		const before = tour.steps.length;
		tour.drop();
		expect(tour.steps).toHaveLength(before - 1);
		expect(tour.step?.id).toBe(TOUR_STEPS[1].id);
	});

	it('skipping the welcome shows the hint, and it is still there on the next page load', () => {
		tour.showHint();
		expect(tour.hint).toBe(true);
		tour.hint = false;
		tour.restoreHint();
		expect(tour.hint).toBe(true);
	});

	it('dismissing the hint keeps it gone on the next page load', () => {
		tour.showHint();
		tour.dismissHint();
		tour.restoreHint();
		expect(tour.hint).toBe(false);
	});

	it('taking the tour from anywhere retires the hint: the person has found it', () => {
		page(all);
		tour.showHint();
		tour.start('menu');
		expect(tour.hint).toBe(false);
		tour.restoreHint();
		expect(tour.hint).toBe(false);
	});

	it('a device that never skipped the welcome gets no hint', () => {
		tour.restoreHint();
		expect(tour.hint).toBe(false);
	});
});

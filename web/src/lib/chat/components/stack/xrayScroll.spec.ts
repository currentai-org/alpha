import { describe, expect, it } from 'vitest';
import { answerFooterDelta, panelBodyShrink } from './xrayScroll';

const view = { top: 100, bottom: 400 };

describe('answerFooterDelta (CUR-3951)', () => {
	it('scrolls the footer up out of the bottom fade when the panel takes the thread height', () => {
		expect(answerFooterDelta(view, { top: 200, bottom: 420 }, 40)).toBe(60);
	});

	it('never scrolls up when the footer already sits above the fade', () => {
		expect(answerFooterDelta(view, { top: 120, bottom: 300 }, 40)).toBe(0);
	});

	it("stops at the answer's start on a short window, so its text stays readable (CUR-3934)", () => {
		// A 600px answer in a 300px thread: reaching the footer would scroll its first 280px away.
		expect(answerFooterDelta(view, { top: 130, bottom: 730 }, 40)).toBe(30);
	});

	it("scrolls back up to an answer's start that the shrinking thread carried just above its top, when the answer fits", () => {
		// What the 690px scenario saw: footer clear, start 10px above the thread's top.
		expect(answerFooterDelta(view, { top: 90, bottom: 330 }, 40)).toBe(-10);
	});

	it('keeps the footer clear for a long answer whose start has already scrolled above the thread', () => {
		// Read from its end: no start to keep in view, so the footer still clears the panel.
		expect(answerFooterDelta(view, { top: 50, bottom: 420 }, 40)).toBe(60);
	});
});

describe('panelBodyShrink (CUR-3951)', () => {
	it('gives back the shortfall when the answer fits the thread only without the panel', () => {
		// A 280px answer starting 20px into a 300px thread with a 40px fade: its footer is 20px short.
		expect(panelBodyShrink(view, { top: 120, bottom: 400 }, 40, 210, 128)).toBe(20);
	});

	it('gives back nothing when the start and the footer already both fit', () => {
		expect(panelBodyShrink(view, { top: 110, bottom: 300 }, 40, 210, 128)).toBe(0);
	});

	it('never shrinks the body below its floor, even for an answer that cannot fit', () => {
		expect(panelBodyShrink(view, { top: 110, bottom: 900 }, 40, 210, 128)).toBe(82);
	});

	it("gives back the whole shortfall once scrolling has stopped with the answer's start at the thread's top", () => {
		// The steady state on a short window: the start sits at the top and the footer is still 60px short.
		expect(panelBodyShrink(view, { top: 100, bottom: 420 }, 40, 210, 128)).toBe(60);
		expect(answerFooterDelta(view, { top: 100, bottom: 420 }, 40)).toBe(0);
	});

	it("leaves the panel alone once the start of an answer too long to fit has scrolled above the thread", () => {
		expect(panelBodyShrink(view, { top: 50, bottom: 420 }, 40, 210, 128)).toBe(0);
	});

	it("gives back what an answer whose start scrolled just above the thread needs to fit whole", () => {
		// 300px of answer in 260px of room: 40px from the body, then answerFooterDelta brings the start back.
		expect(panelBodyShrink(view, { top: 80, bottom: 380 }, 40, 210, 128)).toBe(40);
	});
});

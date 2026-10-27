import { describe, expect, it } from 'vitest';
import { getInvolvedVisible } from './state';

// The card's return interval (state.ts's GET_INVOLVED_RETURN_MS), restated: three days.
const GET_INVOLVED_RETURN_MS = 3 * 24 * 60 * 60 * 1000;

describe('the Get involved card comes back after it is closed', () => {
	const now = 1_800_000_000_000;

	it('shows when it was never closed', () => {
		expect(getInvolvedVisible(null, now)).toBe(true);
	});

	it('stays hidden until the return interval has passed since it was closed', () => {
		expect(getInvolvedVisible(now, now)).toBe(false);
		expect(getInvolvedVisible(now - GET_INVOLVED_RETURN_MS + 1, now)).toBe(false);
	});

	it('shows again once the return interval has passed', () => {
		expect(getInvolvedVisible(now - GET_INVOLVED_RETURN_MS, now)).toBe(true);
	});

	it('shows for a card closed before closing expired (stored as true, read as 0)', () => {
		expect(getInvolvedVisible(0, now)).toBe(true);
	});
});

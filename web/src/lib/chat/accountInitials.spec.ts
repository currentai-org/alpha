import { describe, expect, it } from 'vitest';
import { accountInitials } from './accountInitials';

describe('accountInitials', () => {
	it('takes the first letter of the first two words', () => {
		expect(accountInitials('Ada Lovelace King')).toBe('AL');
	});
	it('gives one letter for a single-word name or an email address', () => {
		expect(accountInitials('ada@example.org')).toBe('a');
	});
	it('falls back to G for an empty name', () => {
		expect(accountInitials('')).toBe('G');
	});
});

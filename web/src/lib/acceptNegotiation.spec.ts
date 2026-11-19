import { describe, expect, it } from 'vitest';
import { addVaryAccept, negotiateType } from './acceptNegotiation';

const OFFERED = ['text/html', 'text/markdown'];

describe('negotiateType picks the offered type the Accept header allows', () => {
	it('returns the first offered type when the header is absent or empty', () => {
		expect(negotiateType(null, OFFERED)).toBe('text/html');
		expect(negotiateType('', OFFERED)).toBe('text/html');
	});

	it('returns the first offered type for a wildcard', () => {
		expect(negotiateType('*/*', OFFERED)).toBe('text/html');
	});

	it('picks markdown when the client names only markdown', () => {
		expect(negotiateType('text/markdown', OFFERED)).toBe('text/markdown');
	});

	it('prefers the higher q-value', () => {
		expect(negotiateType('text/html;q=0.5, text/markdown', OFFERED)).toBe('text/markdown');
		expect(negotiateType('text/markdown;q=0.2, text/html;q=0.9', OFFERED)).toBe('text/html');
	});

	it('breaks a q tie by the order the client listed the types', () => {
		expect(negotiateType('text/markdown, text/html', OFFERED)).toBe('text/markdown');
	});

	it('lets a specific range override a wildcard, including q=0 to exclude', () => {
		expect(negotiateType('*/*, text/html;q=0', OFFERED)).toBe('text/markdown');
		expect(negotiateType('text/*;q=0.1, text/markdown', OFFERED)).toBe('text/markdown');
	});

	it('returns null when nothing offered is acceptable', () => {
		expect(negotiateType('application/json', OFFERED)).toBeNull();
		expect(negotiateType('text/html;q=0, text/markdown;q=0', OFFERED)).toBeNull();
	});

	it('ignores malformed q-values and clamps out-of-range ones', () => {
		expect(negotiateType('text/markdown;q=abc', OFFERED)).toBe('text/markdown');
		expect(negotiateType('text/markdown;q=7, text/html', OFFERED)).toBe('text/markdown');
	});

	it('is case-insensitive about types', () => {
		expect(negotiateType('TEXT/Markdown', OFFERED)).toBe('text/markdown');
	});
});

describe('addVaryAccept', () => {
	it('sets Vary when absent and appends when another token is present', () => {
		const a = new Headers();
		addVaryAccept(a);
		expect(a.get('vary')).toBe('Accept');
		const b = new Headers({ vary: 'Cookie' });
		addVaryAccept(b);
		expect(b.get('vary')).toBe('Cookie, Accept');
	});

	it('leaves Vary alone when Accept is already listed', () => {
		const h = new Headers({ vary: 'cookie, ACCEPT' });
		addVaryAccept(h);
		expect(h.get('vary')).toBe('cookie, ACCEPT');
	});
});

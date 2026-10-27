import { describe, expect, it } from 'vitest';
import { faviconHost, faviconSrc, normalizeFaviconHost } from './favicon';

describe('faviconHost', () => {
	it('reduces a URL to its lowercase host without www', () => {
		expect(faviconHost('https://WWW.Reuters.com/world?x=1#y')).toBe('reuters.com');
		expect(faviconHost('http://news.bbc.co.uk/')).toBe('news.bbc.co.uk');
	});

	it('returns null for anything that is not a public http(s) name', () => {
		for (const url of [
			'',
			'not a url',
			'javascript:alert(1)',
			'ftp://example.com/file',
			'https://127.0.0.1/',
			'https://[::1]/',
			'http://localhost:5173/',
			'https://intranet/'
		]) {
			expect(faviconHost(url), url).toBeNull();
		}
	});
});

describe('normalizeFaviconHost (the route validates its query with this)', () => {
	it('rejects anything that could carry more than a hostname upstream', () => {
		for (const host of [
			'a.com/../x',
			'a.com?x=1',
			'a.com#x',
			'a b.com',
			'-a.com',
			'a-.com',
			'a..com'
		]) {
			expect(normalizeFaviconHost(host), host).toBeNull();
		}
		expect(normalizeFaviconHost('a'.repeat(64) + '.com')).toBeNull();
	});

	it('accepts punycode and trailing-dot names', () => {
		expect(normalizeFaviconHost('xn--bcher-kva.de.')).toBe('xn--bcher-kva.de');
	});
});

describe('faviconSrc', () => {
	it('points at our own route, never the site', () => {
		expect(faviconSrc('https://www.youtube.com/shorts/abc')).toBe('/api/favicon?host=youtube.com');
		expect(faviconSrc(undefined)).toBeNull();
	});

	it('uses our own icon for a path on this site, but not for a protocol-relative URL', () => {
		expect(faviconSrc('/map')).toBe('/favicon.svg');
		expect(faviconSrc('//evil.example/x')).toBeNull();
	});
});

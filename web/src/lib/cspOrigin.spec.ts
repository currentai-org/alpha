import { afterEach, describe, expect, it, vi } from 'vitest';
import { originOf } from './cspOrigin.js';

describe('originOf — a CSP source is a real http(s) origin or nothing', () => {
	it('reduces a configured URL to its origin', () => {
		expect(originOf('https://cms.example.org/some/path?q=1')).toBe('https://cms.example.org');
		expect(originOf('  http://localhost:3001/ ')).toBe('http://localhost:3001');
	});

	it.each([
		['unset', undefined],
		['empty (the manifest scaffold)', ''],
		['blank', '   '],
		['missing its scheme', 'cms.example.org'],
		['opaque, whose origin is the string "null"', 'foo:bar'],
		['a script URL', 'javascript:alert(1)'],
		['a relative path', '/rs']
	])('yields no source when the value is %s', (_label, value) => {
		expect(originOf(value)).toBeUndefined();
	});
});

// The built policy itself, not just the helper: sveltekit.config.js read with the CMS unset must list no
// CMS origin and no empty, "null" or "undefined" source in any directive.
describe('sveltekit.config.js CSP — no broken source when PUBLIC_CMS_PAYLOAD_URL is unset', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.doUnmock('dotenv');
		vi.resetModules();
	});

	async function directives(cms: string): Promise<Record<string, unknown[]>> {
		// Keep a developer's .env.local (loaded with override) from putting the CMS back.
		vi.doMock('dotenv', () => ({ default: { config: () => ({}) } }));
		vi.stubEnv('PUBLIC_CMS_PAYLOAD_URL', cms);
		vi.stubEnv('ALLOW_IFRAME', '');
		vi.resetModules();
		// A computed specifier, so svelte-check does not pull the untyped config into the TS program.
		const configUrl = new URL('../../sveltekit.config.js', import.meta.url).href;
		const { default: config } = (await import(/* @vite-ignore */ configUrl)) as {
			default: { csp?: { directives?: Record<string, unknown[]> } };
		};
		return config.csp?.directives ?? {};
	}

	it.each([
		['unset', ''],
		['not a URL', 'cms.example.org']
	])('emits only well-formed sources when the CMS origin is %s', async (_label, cms) => {
		const d = await directives(cms);
		expect(Object.keys(d)).toContain('img-src');
		for (const [name, sources] of Object.entries(d)) {
			for (const s of sources) {
				expect(typeof s === 'string' && s.trim() !== '', `${name} holds an empty source`).toBe(
					true
				);
				expect(['null', 'undefined'], `${name} holds ${String(s)}`).not.toContain(s);
				expect(String(s), `${name} names the CMS`).not.toContain('cms.example.org');
			}
		}
	});

	it('names the CMS origin in img-src, connect-src and frame-ancestors when it is set', async () => {
		const d = await directives('https://cms.example.org/');
		for (const name of ['img-src', 'connect-src', 'frame-ancestors']) {
			expect(d[name], name).toContain('https://cms.example.org');
		}
	});
});

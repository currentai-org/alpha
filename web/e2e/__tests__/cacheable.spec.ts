import { describe, expect, it } from 'vitest';
import { isCacheable } from '../scenarios/helpers/cacheable';

const at = (path: string) => new URL(`https://aipotluck-abc-current-ai.vercel.app${path}`);

describe('isCacheable (CUR-2675)', () => {
	it('caches content-hashed chunks and posthog-js scripts fixed by the version in their path', () => {
		expect(isCacheable(at('/_app/immutable/chunks/abc123.js'))).toBe(true);
		expect(isCacheable(at('/rs/static/1.427.2/surveys.js'))).toBe(true);
		expect(isCacheable(at('/rs/static/1.427.2/exception-autocapture.js'))).toBe(true);
	});

	it('never caches live flag config or event posts on the PostHog proxy', () => {
		expect(isCacheable(at('/rs/array/phc_key/config.js'))).toBe(false);
		expect(isCacheable(at('/rs/e/'))).toBe(false);
		expect(isCacheable(at('/rs/static/array.js'))).toBe(false);
	});

	it('never caches a page or an API route', () => {
		expect(isCacheable(at('/chat'))).toBe(false);
		expect(isCacheable(at('/chat/api/v2/conversations'))).toBe(false);
	});
});

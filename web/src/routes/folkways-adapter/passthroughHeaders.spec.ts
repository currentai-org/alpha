import { describe, it, expect } from 'vitest';
import { passthroughResponseHeaders } from './passthroughHeaders';

// These names state the CONTRACT rather than the behaviour, per this repo's "Tests and gates"
// rule 1: each one says what must stay true, so a future reader can tell whether a green run
// guarantees what they need. The pair that matters is the first two — a forwarding proxy has to be
// checked in both directions at once, because "forwards everything" and "forwards nothing" each
// pass half of this file. They guard against the adapter dropping every upstream header but
// content-type, which leaves the host unable to name the model that served a turn (CUR-1452).

describe('passthroughResponseHeaders — provenance survives the proxy (CUR-1452)', () => {
	it('forwards x-litellm-model-api-base, without which no turn served through the adapter can name its model', () => {
		const out = passthroughResponseHeaders(
			new Headers({
				'content-type': 'text/event-stream',
				'x-litellm-model-api-base': 'https://api.featherless.ai/v1',
				'x-litellm-model-group': 'swiss-ai/apertus-v1.5-70b',
				'x-litellm-attempted-fallbacks': '0'
			})
		);

		expect(out['x-litellm-model-api-base']).toBe('https://api.featherless.ai/v1');
		expect(out['x-litellm-model-group']).toBe('swiss-ai/apertus-v1.5-70b');
		expect(out['x-litellm-attempted-fallbacks']).toBe('0');
		expect(out['content-type']).toBe('text/event-stream');
	});

	it('withholds set-cookie and www-authenticate, so fixing provenance does not turn an upstream session into ours', () => {
		const out = passthroughResponseHeaders(
			new Headers({
				'content-type': 'application/json',
				'set-cookie': 'upstream_session=abc; Path=/',
				'www-authenticate': 'Bearer realm="upstream"',
				'x-litellm-model-api-base': 'https://api.featherless.ai/v1'
			})
		);

		expect(out['set-cookie']).toBeUndefined();
		expect(out['www-authenticate']).toBeUndefined();
		// The allowed one still comes through — otherwise this test would pass on a function that
		// forwards nothing, which is the defect it exists to catch.
		expect(out['x-litellm-model-api-base']).toBe('https://api.featherless.ai/v1');
	});

	it('forwards x-router-* too, since routerMetadata reads that family on lanes that send it', () => {
		const out = passthroughResponseHeaders(new Headers({ 'x-router-model': 'some/model' }));
		expect(out['x-router-model']).toBe('some/model');
	});

	it("forwards retry-after and retry-after-ms, which chat's retry policy reads on a 429 (CUR-3186)", () => {
		const out = passthroughResponseHeaders(
			new Headers({ 'retry-after': '7', 'retry-after-ms': '7000', 'x-ratelimit-limit': '30' })
		);
		expect(out['retry-after']).toBe('7');
		expect(out['retry-after-ms']).toBe('7000');
		expect(out['x-ratelimit-limit']).toBeUndefined();
	});

	it('defaults content-type to JSON when the upstream omits it, matching what the adapter did before', () => {
		expect(passthroughResponseHeaders(new Headers())['content-type']).toBe('application/json');
	});

	it('matches header names case-insensitively, because a record from a non-Headers source keeps its casing', () => {
		const out = passthroughResponseHeaders({
			'Content-Type': 'text/event-stream',
			'X-LiteLLM-Model-Api-Base': 'https://api.featherless.ai/v1'
		});

		expect(out['content-type']).toBe('text/event-stream');
		expect(out['x-litellm-model-api-base']).toBe('https://api.featherless.ai/v1');
	});
});

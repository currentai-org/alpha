// CSP reports go where analytics go, the same-origin /rs proxy unless configured otherwise.
import { describe, expect, it } from 'vitest';
import { cspReportEndpoint } from './cspReportEndpoint.js';

describe('cspReportEndpoint', () => {
	it('defaults to the same-origin /rs proxy, which every deployment serves', () => {
		expect(cspReportEndpoint({ PUBLIC_POSTHOG_KEY: 'phc_x' })).toBe('/rs/report/?token=phc_x');
	});

	it('uses PUBLIC_POSTHOG_HOST when set', () => {
		expect(
			cspReportEndpoint({
				PUBLIC_POSTHOG_KEY: 'phc_x',
				PUBLIC_POSTHOG_HOST: 'https://eu.i.posthog.com'
			})
		).toBe('https://eu.i.posthog.com/report/?token=phc_x');
	});

	it('returns nothing without a key', () => {
		expect(cspReportEndpoint({})).toBeUndefined();
	});
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNotProduction } from './devOnlyRoute';
import { __resetDeployEnvWarnings } from '$lib/chat/server/deployEnv';

describe('work-in-progress routes stay out of production', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		__resetDeployEnvWarnings();
	});

	it('answers 404 when DEPLOY_ENV is production', () => {
		vi.stubEnv('DEPLOY_ENV', 'production');
		expect(() => assertNotProduction()).toThrow(expect.objectContaining({ status: 404 }));
	});

	it('serves the route on preview', () => {
		vi.stubEnv('DEPLOY_ENV', 'preview');
		expect(() => assertNotProduction()).not.toThrow();
	});
});

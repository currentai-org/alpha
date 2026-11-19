import { error } from '@sveltejs/kit';
import { deployEnvName } from '$lib/server/runtimeEnv';

/**
 * 404 in production for a route that is still a work surface (/alpha, /designsystem). Same shape as
 * localEndpointsGate.ts and agentMode.ts: a plain deployment-environment check, no flag-service round-trip. Preview
 * and local dev serve it; an unset DEPLOY_ENV also serves it, since only production is known public.
 */
export function assertNotProduction(): void {
	if ((deployEnvName() || '').trim() === 'production') error(404, 'Not found');
}

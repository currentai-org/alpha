import { error } from '@sveltejs/kit';
import { deployEnv } from '$lib/chat/server/deployEnv';

/**
 * 404 in production for a route that is still a work surface (/alpha, /designsystem). Same shape as
 * localEndpointsGate.ts and agentMode.ts: a plain deployEnv() check, no flag-service round-trip. Preview
 * and local dev serve it; an unset DEPLOY_ENV also serves it, since only production is known public.
 */
export function assertNotProduction(): void {
	if (deployEnv() === 'production') error(404, 'Not found');
}

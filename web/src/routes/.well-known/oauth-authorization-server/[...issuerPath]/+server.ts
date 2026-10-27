// RFC 8414 discovery for Alpha's OAuth provider. The issuer is
// https://<host>/chat/api/auth, so the spec's location is
// /.well-known/oauth-authorization-server/chat/api/auth; the bare path answers too, because that is
// where the sync contract tells its client to look. Both sit outside /chat, where Better Auth's own
// catch-all can't reach, so the plugin's helper serves its metadata from here.
//
// The registered sync clients read this with fetch from their own origin, so it carries their CORS.
// No flag gate: the document only names endpoints, and every grant step behind them is gated. (CUR-4312)
import { error, type RequestHandler } from '@sveltejs/kit';
import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { getAuth } from '$lib/chat/server/betterAuth';
import { AUTH_BASE_PATH } from '$lib/chat/paths';
import { syncCorsHeaders, syncPreflight } from '$lib/chat/server/sync/syncCors';

export const GET: RequestHandler = async ({ request, params }) => {
	const issuerPath = params.issuerPath ?? '';
	if (issuerPath !== '' && `/${issuerPath}` !== AUTH_BASE_PATH) error(404, 'Not found');
	const upstream = await oauthProviderAuthServerMetadata(getAuth())(request);
	const headers = new Headers(upstream.headers);
	for (const [k, v] of Object.entries(syncCorsHeaders(request.headers.get('origin'))))
		headers.set(k, v);
	return new Response(upstream.body, { status: upstream.status, headers });
};

export const OPTIONS: RequestHandler = ({ request }) =>
	syncPreflight(request.headers.get('origin'));

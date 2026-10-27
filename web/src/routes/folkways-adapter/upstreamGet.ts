// Folkways adapter — shared GET passthrough to the real gateway, used by `v1/models` (the catalog)
// and `v1/model/info` (deployment info, CUR-2092). Both proxy one path upstream unchanged.
//
// Env:
//   FOLKWAYS_CATALOG_BASE_URL   (default https://api-internal.publicai.co/v1) — the REAL
//                               gateway the adapter fronts.
//   FOLKWAYS_CATALOG_API_KEY    (falls back to OPENAI_API_KEY, then HF_TOKEN) — gateway auth.

import { env } from '$env/dynamic/private';
import { adapterGate } from './flag';
import { json } from './json';

export async function proxyUpstreamGet(request: Request, path: string): Promise<Response> {
	const gate = await adapterGate(request);
	if (gate) return gate;
	const base = (env.FOLKWAYS_CATALOG_BASE_URL ?? 'https://api-internal.publicai.co/v1').replace(
		/\/$/,
		''
	);
	// Prefer the auth the host already sent (its OPENAI_API_KEY); fall back to explicit config.
	const incoming = request.headers.get('authorization');
	const key = env.FOLKWAYS_CATALOG_API_KEY || env.OPENAI_API_KEY || env.HF_TOKEN || '';
	const authorization = incoming || (key ? `Bearer ${key}` : '');

	try {
		const upstream = await fetch(`${base}${path}`, {
			headers: authorization ? { authorization } : {},
			signal: AbortSignal.timeout(8000)
		});
		return new Response(upstream.body, {
			status: upstream.status,
			headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
		});
	} catch (err) {
		console.error(`[folkways-adapter] ${path} proxy failed: ${(err as Error).message}`);
		return json(502, { error: { message: `${path} upstream unreachable` } });
	}
}

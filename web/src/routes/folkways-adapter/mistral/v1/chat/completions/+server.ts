// Folkways adapter — the Mistral lane (CUR-3186).
//
// Chat sends Mistral models (Large 3 among them) to `MISTRAL_CHAT_BASE_URL`, never to
// `OPENAI_BASE_URL`, so the gateway route next door never sees them. Pointing
// `MISTRAL_CHAT_BASE_URL` at `<app>/folkways-adapter/mistral/v1` puts this route in front of them.
//
// Observe only, whatever FOLKWAYS_MODE says: resolve mode forces the release's model, which is a
// gateway model id Mistral does not serve. The request goes upstream as the exact bytes chat sent,
// with chat's own bearer, and the upstream body comes back untouched. That matters here: Mistral
// streams `delta.content` as a list of parts (text plus `reference` parts carrying citations) and
// tool-call deltas, which a proxy that re-serializes content into a string loses (CUR-3067). The
// trace and reports come from the shared observe pipeline in ../../../../observe.ts.
//
// Env:
//   FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL  (default https://api.mistral.ai/v1) — set it to whatever
//                                       MISTRAL_CHAT_BASE_URL named before it pointed here.
//   Caller auth: the bearer must be MISTRAL_CHAT_API_KEY, the router lane's key
//   (../../../../flag.ts mistralCallerAuthorized).

import { env } from '$env/dynamic/private';
import { adapterGate, mistralCallerAuthorized } from '../../../../flag';
import { ADAPTER_ID, ADAPTER_VERSION, handleObserve } from '../../../../observe';
import { json } from '../../../../json';

const DEFAULT_UPSTREAM = 'https://api.mistral.ai/v1';

const upstreamBaseUrl = () =>
	(env.FOLKWAYS_MISTRAL_UPSTREAM_BASE_URL?.trim() || DEFAULT_UPSTREAM).replace(/\/$/, '');

export const POST = async ({ request }: { request: Request }) => {
	const gate = await adapterGate(request, mistralCallerAuthorized);
	if (gate) return gate;
	// The gate has checked this header is one of the host's Mistral keys; it goes upstream as is.
	const authorization = request.headers.get('authorization') ?? '';
	return handleObserve(request, {
		detail: { lane: 'mistral' },
		forward: (_body, raw) =>
			fetch(`${upstreamBaseUrl()}/chat/completions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization },
				body: raw
			})
	});
};

// Health probe, same gate as the POST.
export const GET = async ({ request }: { request: Request }) => {
	const gate = await adapterGate(request, mistralCallerAuthorized);
	if (gate) return gate;
	return json(200, {
		ok: true,
		adapter: `${ADAPTER_ID}@${ADAPTER_VERSION}`,
		lane: 'mistral',
		mode: 'observe',
		upstream: new URL(upstreamBaseUrl()).host
	});
};

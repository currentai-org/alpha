// Folkways adapter — gateway deployment-info passthrough (CUR-2092).
//
// apertusStrictLane.ts reads `<OPENAI_BASE_URL>/model/info` to find which deployment in an Apertus
// group accepts real roles. On a host whose OPENAI_BASE_URL points at this adapter, that read lands
// here and is proxied to the upstream gateway unchanged. Without it the lookup 404s and requests
// stay unpinned, which is the safe default.

import { proxyUpstreamGet } from '../../../upstreamGet';

export const GET = async ({ request }: { request: Request }) =>
	proxyUpstreamGet(request, '/model/info');

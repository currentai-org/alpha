// Folkways adapter — catalog passthrough.
//
// When the host points OPENAI_BASE_URL at this adapter (so EVERY completion flows
// through Folkways), the host still fetches its model catalog from `<base>/models`.
// This route proxies that GET to the real upstream catalog unchanged, so the host's
// model list (and the picker) stays exactly as before. Only /chat/completions applies
// Folkways behavior; the catalog is passed through verbatim. Env: see ../../upstreamGet.ts.

import { proxyUpstreamGet } from "../../upstreamGet";

export const GET = async ({ request }: { request: Request }) => proxyUpstreamGet(request, "/models");

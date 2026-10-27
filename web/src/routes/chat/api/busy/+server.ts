import type { RequestHandler } from "@sveltejs/kit";
import { json } from "$lib/chat/server/api/utils/json";
import { readBusyModels } from "$lib/chat/server/chatShellData";

// The models Auto routes around right now, re-read by an open chat tab once a minute
// (routing/busyHere.ts). The layout data carries the same list but only as of the page load, so a tab
// open before a model became unavailable keeps sending Auto's turns to it, and one open before it recovered keeps
// routing around it until a reload. One indexed read of `alert_state` (modelBusy.ts), and empty on any
// read failure, so Auto falls back to its normal pick.
//
// `private`: under a spec's busy scope (the fault-inject gate) the answer is that spec's own marks, which
// must never reach a shared cache. The browser holds it for less than the tab's refresh interval. (CUR-4629)
export const GET: RequestHandler = async ({ request }) => {
	const busyModels = await readBusyModels(request);
	return json({ busyModels }, { headers: { "Cache-Control": "private, max-age=30" } });
};

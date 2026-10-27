// The busy marks this tab set itself. A turn whose stream ends on a 429 came from the model's
// host (our own limiter refuses before the stream opens, upstreamBusy.ts), so the model is busy for this
// person now, before the server's three-in-a-row mark catches up. The mark lasts ten minutes and lives
// only for the page, so a reload starts from the server's view. The server's own mark (modelBusy.ts) holds
// until the model answers a turn or the warm cron's probe. (CUR-4043)

import { on } from 'svelte/events';
import { writable } from 'svelte/store';
import { base } from '$lib/chat/paths';

/** @internal exported for its unit tests */
export const BUSY_HERE_MS = 10 * 60 * 1000;

const marks = writable<Map<string, number>>(new Map());

/** Marks `modelId` busy in this tab for BUSY_HERE_MS from now. */
export function markBusyHere(modelId: string, now = Date.now()): void {
	marks.update((m) => new Map(m).set(modelId, now + BUSY_HERE_MS));
}

/** The ids whose mark has not run out at `now`.
 *  @internal exported for its unit tests */
export function busyHereAt(m: Map<string, number>, now = Date.now()): string[] {
	return [...m].filter(([, until]) => until > now).map(([id]) => id);
}

export const busyHere = { subscribe: marks.subscribe };

// The server's marks as this tab last read them from `/chat/api/busy`. The layout data
// (`page.data.busyModels`) holds them only as of the page load, and the chat layout never reloads on its
// own, so a tab left open keeps routing to a model that became unavailable after the page loaded, and around one that
// has since recovered. Null until the first read lands, when the layout's copy is still the newest. (CUR-4629)
const serverMarks = writable<string[] | null>(null);
export const serverBusy = { subscribe: serverMarks.subscribe };

/** How often an open chat tab re-reads the server's marks. The warm probe re-checks each model every
 *  four minutes (modelProbe.ts), so a mark set or cleared there reaches the tab within a minute after. */
export const SERVER_BUSY_REFRESH_MS = 60_000;

/** Reads the server's marks now. Keeps the last list on any failure, so a lost read never un-marks or
 *  marks anything.
 *  @internal exported for its unit tests */
export async function refreshServerBusy(fetcher: typeof fetch = fetch): Promise<void> {
	try {
		const res = await fetcher(`${base}/api/busy`);
		if (!res.ok) return;
		const body = (await res.json()) as { busyModels?: unknown };
		if (Array.isArray(body.busyModels))
			serverMarks.set(body.busyModels.filter((id): id is string => typeof id === 'string'));
	} catch {
		// Keep the last list.
	}
}

/** Re-reads the server's marks every `everyMs` (the layout's `busyRefreshMs`) while the tab is visible,
 *  and at once when it becomes visible again. Returns the stop. */
export function keepServerBusyFresh(everyMs: number, fetcher: typeof fetch = fetch): () => void {
	if (typeof document === 'undefined') return () => {};
	const tick = () => {
		if (document.visibilityState === 'visible') void refreshServerBusy(fetcher);
	};
	const id = setInterval(tick, everyMs);
	const off = on(document, 'visibilitychange', tick);
	return () => {
		clearInterval(id);
		off();
	};
}

/** The server's marks to route around: this tab's latest read, else the page load's. */
export function serverBusyNow(pageBusy: string[] | undefined, fresh: string[] | null): string[] | undefined {
	return fresh ?? pageBusy;
}

/** Every model Auto should route around now: the server's marks (`serverBusyNow`) and this tab's own.
 *  The composer's forecast and the landing's first send both read this, so the model the explanation
 *  names as busy is never the one the message goes to. */
export function busyNow(serverBusy: string[] | undefined, m: Map<string, number>, now = Date.now()): string[] {
	return [...new Set([...(serverBusy ?? []), ...busyHereAt(m, now)])];
}

import { logger } from "$lib/chat/server/logger";
import { DEPLOYMENT } from "$lib/deployment";

// The chat's incident banner reads the status page's own state, so it shows exactly when
// the installation's status page (Better Stack) says something is wrong and never otherwise. Every chat page asks,
// so the answer is held for a minute per instance: Better Stack sees about one request a minute per
// instance however many people are chatting, and a new incident reaches the banner within a minute.

// Which status page: STATUS_PAGE_URL when set (a Better Stack page, read at its /index.json), else the
// deployment file's statusPageUrl (src/lib/deployment.ts), except on a self-host edition
// (ALPHA_EDITION=selfhost), where unset means no status page and no banner: a self-hosted Alpha must not
// ask another installation's status page anything, nor show its incidents.
const HOSTED_STATUS_PAGE_URL = DEPLOYMENT.statusPageUrl;

/** The status page the banner reads and links to, or null for none. */
export function statusPageUrl(): string | null {
	const set = (process.env.STATUS_PAGE_URL ?? "").trim().replace(/\/+$/, "");
	if (set) return set;
	const selfHost = (process.env.ALPHA_EDITION ?? "").trim().toLowerCase() === "selfhost";
	return selfHost ? null : HOSTED_STATUS_PAGE_URL;
}

const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;

/** Better Stack's `aggregate_state` values; any other value is read as unknown. */
const STATES = ["operational", "degraded", "downtime", "maintenance"] as const;
export type StatusPageState = (typeof STATES)[number];

let cached: { state: StatusPageState | null; at: number; url: string } | null = null;

/** The status page's overall state, or null when it could not be read or none is configured. A failed
 *  read is cached like a good one, so a status page that is itself down costs each instance one slow
 *  request a minute. With no status page (statusPageUrl() null) nothing is fetched. */
export async function statusPageState(
	fetchImpl: typeof fetch = fetch,
	now: number = Date.now()
): Promise<StatusPageState | null> {
	const url = statusPageUrl();
	if (!url) return null;
	if (cached && cached.url === url && now - cached.at < CACHE_MS) return cached.state;
	cached = { state: await readState(fetchImpl, url), at: now, url };
	return cached.state;
}

async function readState(fetchImpl: typeof fetch, url: string): Promise<StatusPageState | null> {
	try {
		const res = await fetchImpl(`${url}/index.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!res.ok) {
			logger.warn({ status: res.status }, "[status-page] read failed");
			return null;
		}
		const body = (await res.json()) as { data?: { attributes?: { aggregate_state?: unknown } } };
		const state = body.data?.attributes?.aggregate_state;
		return STATES.find((s) => s === state) ?? null;
	} catch (err) {
		logger.warn({ err: String(err) }, "[status-page] read failed");
		return null;
	}
}

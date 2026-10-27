import { logger } from "$lib/chat/server/logger";

// The chat's incident banner reads the status page's own state, so it shows exactly when
// status.aipotluck.org (Better Stack) says something is wrong and never otherwise. Every chat page asks,
// so the answer is held for a minute per instance: Better Stack sees about one request a minute per
// instance however many people are chatting, and a new incident reaches the banner within a minute. (CUR-4062)

const STATUS_PAGE_URL = "https://status.aipotluck.org";
const STATUS_JSON_URL = `${STATUS_PAGE_URL}/index.json`;
const CACHE_MS = 60_000;
const FETCH_TIMEOUT_MS = 2_000;

/** Better Stack's `aggregate_state` values; any other value is read as unknown. */
const STATES = ["operational", "degraded", "downtime", "maintenance"] as const;
export type StatusPageState = (typeof STATES)[number];

let cached: { state: StatusPageState | null; at: number } | null = null;

/** The status page's overall state, or null when it could not be read. A failed read is cached like a
 *  good one, so a status page that is itself down costs each instance one slow request a minute. */
export async function statusPageState(
	fetchImpl: typeof fetch = fetch,
	now: number = Date.now()
): Promise<StatusPageState | null> {
	if (cached && now - cached.at < CACHE_MS) return cached.state;
	cached = { state: await readState(fetchImpl), at: now };
	return cached.state;
}

async function readState(fetchImpl: typeof fetch): Promise<StatusPageState | null> {
	try {
		const res = await fetchImpl(STATUS_JSON_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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

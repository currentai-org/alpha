/**
 * A limit on `/chat/api/fetch-url`, the proxy that fetches a URL a visitor attaches by link.
 * Without it, anyone could use our servers to fetch arbitrary pages as fast as they liked.
 *
 * Two keys, counted through eventWindow.ts like every other limit on `message_events`:
 *   - per session (the user id, or a guest's minted session id): FETCH_URL_PER_SESSION a minute.
 *     Attaching links is a handful of fetches per message, so ten covers a real person.
 *   - per IP: FETCH_URL_PER_IP a minute, a room-sized backstop for a caller who rotates sessions.
 *     A few hundred visitors behind one event NAT would each have to attach a link in the same
 *     minute to reach it. Same "rate-limit" hash domain as chat/rateLimit.ts, whose rows already
 *     pair an ipHash with a userId, so these rows add no new join.
 *
 * FAILS OPEN on a count error, like the per-minute chat limits: the route still applies the strict
 * SSRF guard and its size cap, so a database blip costs a little extra fetching and nothing more. (CUR-3191)
 */
import { recordEvent, countLiveEvents } from "$lib/chat/server/db/eventWindow";
import { hashIp } from "$lib/chat/server/db/ipHash";

const FETCH_URL_TYPE = "fetchUrl";
const FETCH_URL_PER_SESSION = 10;
const FETCH_URL_PER_IP = 300;
const WINDOW_MS = 60_000;

/** Which limit refused, or "ok". An allowed fetch is recorded against both keys. */
export async function fetchUrlAllowed(opts: {
	userId: string;
	clientAddress: string;
}): Promise<"ok" | "session" | "ip"> {
	const ipHash = hashIp(opts.clientAddress, "rate-limit") ?? undefined;
	const [perSession, perIp] = await Promise.all([
		countLiveEvents({ type: FETCH_URL_TYPE, userId: opts.userId }, "fetch-url-rate:session"),
		ipHash ? countLiveEvents({ type: FETCH_URL_TYPE, ipHash }, "fetch-url-rate:ip") : null,
	]);
	if (perSession !== null && perSession >= FETCH_URL_PER_SESSION) return "session";
	if (perIp !== null && perIp >= FETCH_URL_PER_IP) return "ip";
	await recordEvent({ type: FETCH_URL_TYPE, userId: opts.userId, ipHash }, WINDOW_MS, "fetch-url-rate");
	return "ok";
}

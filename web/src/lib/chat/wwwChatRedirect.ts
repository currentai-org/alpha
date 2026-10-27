import { CHAT_ALIAS_HOSTS, CHAT_HOST, WWW_HOST, chatHostPath } from './paths';

/** The hosts a guest may arrive from with a session cookie the chat host cannot see (CUR-4439). */
export const GUEST_HANDOFF_SOURCE_HOSTS: readonly string[] = [WWW_HOST, ...CHAT_ALIAS_HOSTS];

/**
 * A browser loading a whole page: a GET or HEAD that is a top-level navigation (`Sec-Fetch-Mode:
 * navigate`), or, from a client that sends no fetch metadata such as a crawler, one that accepts HTML.
 * A framed page also navigates; only a document load counts, so an embed keeps working where it is.
 */
export function isPageLoad(method: string, headers: Pick<Headers, 'get'>): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false;
	const mode = headers.get('sec-fetch-mode');
	const dest = headers.get('sec-fetch-dest');
	return mode
		? mode === 'navigate' && (!dest || dest === 'document')
		: (headers.get('accept') ?? '').includes('text/html');
}

/**
 * Where a request to www's /chat should go instead, or null to serve it on www as before (CUR-4439).
 *
 * Only a page load moves (`isPageLoad`). A navigation into /chat/api (an OAuth or connector callback,
 * a link in an email) moves too, because the flow's state cookie was set host-only on alpha.
 *
 * Everything else is answered on www unchanged: fetches, POSTs, Vercel crons, monitors, external API
 * clients and `/chat/.well-known/*`, which an authorization server fetches by its exact URL. None of
 * them can be relied on to follow a cross-host redirect with its method, body and credentials intact.
 */
export function wwwChatRedirect(
	url: URL,
	method: string,
	headers: Pick<Headers, 'get'>,
	pathname: string
): string | null {
	if (url.hostname !== WWW_HOST) return null;
	// www's own `/chat` paths: www is always the site surface (CUR-4448).
	// eslint-disable-next-line chat-paths/no-chat-path-literal -- www is the site surface
	if (pathname !== '/chat' && !pathname.startsWith('/chat/')) return null;
	// eslint-disable-next-line chat-paths/no-chat-path-literal -- www is the site surface
	if (pathname.startsWith('/chat/.well-known/')) return null;
	if (!isPageLoad(method, headers)) return null;
	return `https://${CHAT_HOST}${chatHostPath(url.pathname)}${url.search}`;
}

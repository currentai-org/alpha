// The chat entry point. `/chat` is code-owned on every target (CUR-2195), so there is one path and
// nothing to resolve per target; `/alpha/chat`, the old entry while the landing page lived in the
// CMS, now 308s here.

// A run against a chat-surface deployment (APP_SURFACE=chat, chat at the root of its host)
// sets SCENARIO_CHAT_SURFACE=1. There `/chat` 308s to `/`, so the entry check below would fail on it.
const CHAT_SURFACE = process.env.SCENARIO_CHAT_SURFACE === '1';
export const CHAT_ENTRY = CHAT_SURFACE ? '/' : '/chat';

/**
 * A chat page's path on this run's target: `/chat/login` on a site-surface run, `/login` on a
 * chat-surface one, where `/chat/x` would 308 (CUR-4448). Pages only: the reserved API paths
 * (`/chat/api/...`) keep their prefix on both, so a fetch of one is written out in full.
 */
export function chatPath(path: `/${string}`): string {
	return CHAT_SURFACE ? path : `/chat${path}`;
}

/** A conversation page's URL on this run's target: `/chat/conversation/<id>`, or `/conversation/<id>` on a chat-surface run. */
export const CONVERSATION_URL = CHAT_SURFACE
	? /\/\/[^/]+\/conversation\/[a-f0-9]+/
	: /\/chat\/conversation\/[a-f0-9]+/;

/**
 * Confirm `baseURL` serves the chat entry directly, once per run, before any spec depends on it.
 *
 * Redirects are NOT followed: a 3xx means something (a CMS redirect, a platform rule) is sending
 * chat's own path elsewhere, which is the regression CUR-2195 exists to prevent.
 */
export async function checkChatEntry(baseURL: string): Promise<void> {
	const url = new URL(CHAT_ENTRY, baseURL);
	const res = await fetch(url, { redirect: 'manual' });
	if (res.ok) return;
	if (res.status >= 500) {
		const body = await res.text().catch((err) => `<failed to read body: ${err}>`);
		// This message's "the path is right and the application threw" clause is matched
		// verbatim by scenario-suite-check.yml's CUR-1589 teardown-race carve-out — a 5xx here is
		// exactly what happens once a PR's Neon branch is torn down mid-run, so the carve-out greps
		// the suite's captured output for this text as its evidence of the race, alongside PR state,
		// before waving a failure off. Reword this clause and the carve-out silently stops
		// recognizing the one signature it exists to catch.
		throw new Error(
			`${url} answered ${res.status} — the path is right and the application threw. ` +
				`Response body: ${body}`
		);
	}
	const location = res.headers.get('location');
	throw new Error(
		`${url} answered ${res.status}${location ? ` -> ${location}` : ''}, not 200. Chat's entry ` +
			`is code-owned (CUR-2195); check for a CMS redirect or page shadowing it.`
	);
}

/**
 * The chat entry path every scenario spec starts from.
 *
 * With `SCENARIO_MODEL` set, a spec enters on `/chat/models/<id>`, which starts the chat on
 * that model the way a visitor following a model link would. The gallery's `prod` profile sets it
 * to production's default so a promotion is graded on the model production serves, while other targets
 * keep their own default. A spec whose subject IS the unpinned entry (the settings pick,
 * where a sign-in lands) uses `CHAT_ENTRY` instead, since a pinned URL overrides the first and
 * changes the second.
 */
export function chatEntry(): string {
	const model = process.env.SCENARIO_MODEL;
	return model ? `/chat/models/${model}` : CHAT_ENTRY;
}

/**
 * The chat entry for a spec whose assertion rests on how a strong model answers: a long essay to
 * stop or scroll through, a saved instruction followed, a full recipe. Per-ticket previews default to
 * Mistral Small to keep the suite off the large models' bill (CUR-2716), and Small answers those briefly
 * or loosely, so these few specs enter on Large 4, a strong model every site offers. `SCENARIO_MODEL`
 * still wins, so the gallery's `prod` profile grades them on production's default.
 */
/**
 * Mistral Large 4, for a spec that pins a picked model other than the default Medium, whatever
 * `SCENARIO_MODEL` says. A spec here pins it by URL, so the default does not reach it. Large 3 is on no
 * site's picker (CUR-4683).
 */
export const LARGE4_MODEL = 'mistral-large-2610';
/** Mistral Medium 3.5, every site's default, for a spec that pins the model a visitor gets. */
export const MEDIUM_MODEL = 'mistral-medium-2604';
/**
 * `SCENARIO_ANSWER_MODEL` swaps Large 4 out of these specs. The per-PR suite sets it to Mistral Medium,
 * which answers at full length and is the default on every site.
 */
export function answerShapeEntry(): string {
	return process.env.SCENARIO_MODEL
		? chatEntry()
		: `/chat/models/${process.env.SCENARIO_ANSWER_MODEL || LARGE4_MODEL}`;
}

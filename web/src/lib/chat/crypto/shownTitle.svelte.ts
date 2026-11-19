// The title a person sees for a conversation, on every surface that shows one: the sidebar
// row, the thread header, the conversation page and search. One helper, so no surface shows a sealed
// row's empty skeleton `title` while another shows the opened one.
//
// A sealed title opens in the browser with the unlocked history key. The opened text is cached in
// memory by conversation id, revision, blob and the keyring's epoch, so a key change (another account,
// a sign-out) never serves a title the previous key opened. The reader is imported only when a sealed
// title is first shown, so a list of plaintext titles never loads the cipher.

import { SvelteMap } from 'svelte/reactivity';
import { historyKeyring } from './historyKeyring.svelte';
import type { SealedState } from './sealedShape';

const LOCKED_TITLE = 'Locked chat';
const UNREADABLE_TITLE = "Chat that can't be opened";

/** A conversation as any surface holds it: a sidebar row (`sealedTitle`), or a view the page load
 *  already opened (`titleState` when it could not). */
export type TitleParts = {
	id: string | { toString(): string };
	title?: string;
	sealedTitle?: string;
	sealedTitleRev?: number;
	titleState?: SealedState;
};

const opened = new SvelteMap<string, { text: string; state?: SealedState }>();
// Not reactive on purpose: `shownTitle` writes it while a `$derived` reads, and nothing renders from it.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const inflight = new Set<string>();

const labelFor = (state: SealedState) => (state === 'locked' ? LOCKED_TITLE : UNREADABLE_TITLE);

function request(key: string, epoch: number, identity: string, id: string, blob: string, rev?: number) {
	if (inflight.has(key)) return;
	inflight.add(key);
	void import('./sealedHistory')
		.then(({ openSealedText }) => openSealedText(blob, 'title', id, rev, identity))
		.then((r) => {
			if (historyKeyring.epoch !== epoch) return;
			for (const k of opened.keys()) if (!k.startsWith(`${epoch}\n`)) opened.delete(k);
			opened.set(key, r);
		})
		.catch((e) => console.error('[history-key] could not open a sealed title', e))
		.finally(() => inflight.delete(key));
}

/** The title to show. Reactive: read it in a `$derived` and it updates when the sealed title opens. */
export function shownTitle(c: TitleParts): string {
	if (c.titleState) return labelFor(c.titleState);
	if (!c.sealedTitle) return c.title ?? '';
	const identity = historyKeyring.identity;
	if (!identity) return LOCKED_TITLE;
	const epoch = historyKeyring.epoch;
	const id = String(c.id);
	const key = `${epoch}\n${id}\n${c.sealedTitleRev}\n${c.sealedTitle}`;
	const hit = opened.get(key);
	if (hit) return hit.state ? labelFor(hit.state) : hit.text;
	// Started from a read, but writes state only when the open settles, never during the read.
	request(key, epoch, identity, id, c.sealedTitle, c.sealedTitleRev);
	return LOCKED_TITLE;
}

/**
 * The open conversation's title, for the thread header and the page: the sidebar row's, unless that row
 * is sealed and the page load has already opened the same conversation, whose view needs no second open.
 */
export function shownThreadTitle(listed: TitleParts | undefined, loaded: TitleParts | undefined): string | undefined {
	if (listed && !(listed.sealedTitle && loaded)) return shownTitle(listed);
	return loaded ? shownTitle(loaded) : undefined;
}

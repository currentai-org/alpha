import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateHistoryIdentity } from './historyIdentity';
import { historyKeyring } from './historyKeyring.svelte';
import { sealEnvelope } from './sealedHistory';
import { shownThreadTitle, shownTitle } from './shownTitle.svelte';

// The one title helper every surface reads: sidebar row, thread header, page, search.

const CONV = 'conv-title-1';
const LOCKED_TITLE = 'Locked chat';
const UNREADABLE_TITLE = "Chat that can't be opened";

/** Read the title until the open it started settles to `want`. */
const settlesTo = (row: Parameters<typeof shownTitle>[0], want: string) =>
	vi.waitFor(() => expect(shownTitle(row)).toBe(want));

async function sealedRow(recipient: string, text = 'Capitals', rev = 1) {
	return {
		id: CONV,
		title: '',
		sealedTitle: await sealEnvelope(recipient, { v: 1, kind: 'title', conversationId: CONV, rev, text }),
		sealedTitleRev: rev
	};
}

afterEach(() => historyKeyring.clear());

describe('shownTitle', () => {
	it('shows a plaintext title as it is, empty included', () => {
		expect(shownTitle({ id: CONV, title: 'Rivers' })).toBe('Rivers');
		expect(shownTitle({ id: CONV, title: '' })).toBe('');
	});

	it("shows a sealed row's opened title once the key opens it, never its empty skeleton title", async () => {
		const { identity, recipient } = await generateHistoryIdentity();
		const row = await sealedRow(recipient);
		expect(shownTitle(row)).toBe(LOCKED_TITLE);
		historyKeyring.hold('user:a', identity);
		expect(shownTitle(row)).toBe(LOCKED_TITLE);
		await settlesTo(row, 'Capitals');
	});

	it('never serves a title another key opened: the cache is keyed by the keyring, not only the blob', async () => {
		const a = await generateHistoryIdentity();
		const b = await generateHistoryIdentity();
		const row = await sealedRow(a.recipient);
		historyKeyring.hold('user:a', a.identity);
		await settlesTo(row, 'Capitals');

		historyKeyring.hold('user:b', b.identity);
		expect(shownTitle(row)).toBe(LOCKED_TITLE);
		await settlesTo(row, UNREADABLE_TITLE);

		historyKeyring.clear();
		expect(shownTitle(row)).toBe(LOCKED_TITLE);
	});

	it("labels a page view whose title did not open by its state, not by its empty title", () => {
		expect(shownTitle({ id: CONV, title: '', titleState: 'locked' })).toBe(LOCKED_TITLE);
		expect(shownTitle({ id: CONV, title: '', titleState: 'unreadable' })).toBe(UNREADABLE_TITLE);
	});
});

describe('shownThreadTitle', () => {
	it("prefers the page's opened view over a sealed row's empty title", () => {
		const row = { id: CONV, title: '', sealedTitle: 'blob', sealedTitleRev: 1 };
		expect(shownThreadTitle(row, { id: CONV, title: 'Capitals' })).toBe('Capitals');
		expect(shownThreadTitle(row, { id: CONV, title: '', titleState: 'locked' })).toBe(LOCKED_TITLE);
	});

	it('keeps a plaintext row ahead of the page, and falls back to the page with no row', () => {
		expect(shownThreadTitle({ id: CONV, title: 'Renamed' }, { id: CONV, title: 'Old' })).toBe('Renamed');
		expect(shownThreadTitle(undefined, { id: CONV, title: 'Old' })).toBe('Old');
		expect(shownThreadTitle(undefined, undefined)).toBeUndefined();
	});
});

describe('historyKeyring.keepOnlyFor', () => {
	it("forgets the last user's identity when the session's user changes without a reload", () => {
		historyKeyring.hold('user:a', 'AGE-SECRET-KEY-A');
		historyKeyring.keepOnlyFor('user:a');
		expect(historyKeyring.identity).toBe('AGE-SECRET-KEY-A');
		const before = historyKeyring.epoch;
		historyKeyring.keepOnlyFor('guest');
		expect(historyKeyring.identity).toBeNull();
		expect(historyKeyring.epoch).toBeGreaterThan(before);
	});
});

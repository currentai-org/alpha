import { beforeEach, describe, expect, it } from 'vitest';
import { historyKeyring } from './historyKeyring.svelte';
import { rememberBody, rememberSent, sealedHistoryForTurn, sentBody } from './openedHistory';

// What this tab opened of sealed chats does not outlive the account it was opened for. The
// keyring holds the identity; openedHistory holds the bodies it opened and what this tab sent. Named
// `.svelte.spec.ts` because the keyring uses runes, which only the `client` project compiles.

const CONV = '6543210fedcba98765432100';
const SALT = 'A'.repeat(43);

describe('the history keyring drops opened history with the identity', () => {
	beforeEach(() => {
		historyKeyring.clear();
		historyKeyring.keepOnlyFor('user:a');
	});

	it('forgets every opened body and preprompt on sign-out', () => {
		historyKeyring.hold('user:a', 'AGE-SECRET-KEY-PQ-1TEST');
		rememberBody(CONV, 'm1', 0, { content: 'opened words' }, SALT);
		expect(sealedHistoryForTurn(CONV, ['m1']).history).toHaveLength(1);

		historyKeyring.keepOnlyFor('guest');
		expect(historyKeyring.identity).toBeNull();
		expect(sealedHistoryForTurn(CONV, ['m1'])).toEqual({});
	});

	it("forgets them when another account's identity replaces the held one", () => {
		historyKeyring.hold('user:a', 'AGE-SECRET-KEY-PQ-1TEST');
		rememberBody(CONV, 'm1', 0, { content: 'opened words' });
		historyKeyring.hold('user:b', 'AGE-SECRET-KEY-PQ-1OTHER');
		expect(sealedHistoryForTurn(CONV, ['m1'])).toEqual({});
	});

	it('forgets what a locked tab sent itself when the session changes owner, though no identity was held', () => {
		rememberSent(CONV, { rev: 0, text: 'instructions', salt: SALT }, [{ id: 's', rev: 0, body: { content: 'instructions' }, salt: SALT }]);
		expect(sentBody(CONV, 's', 0)).toEqual({ content: 'instructions' });

		historyKeyring.keepOnlyFor('user:b');
		expect(sentBody(CONV, 's', 0)).toBeUndefined();
		expect(sealedHistoryForTurn(CONV, ['s'])).toEqual({});
	});

	it('keeps what the same owner opened when nothing changed hands', () => {
		historyKeyring.hold('user:a', 'AGE-SECRET-KEY-PQ-1TEST');
		rememberBody(CONV, 'm1', 0, { content: 'opened words' }, SALT);
		historyKeyring.keepOnlyFor('user:a');
		expect(sealedHistoryForTurn(CONV, ['m1']).history).toEqual([{ id: 'm1', rev: 0, body: { content: 'opened words' }, salt: SALT }]);
	});
});

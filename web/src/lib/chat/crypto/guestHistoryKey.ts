// A guest's history key on any page. The key is made only once a conversation page shows,
// after the guest's first turn, but an existing key is opened on every page: the chat list's sealed
// titles and Search chats read sealed chats from the landing page too, and without the identity they
// show every sealed chat as locked and never find one.

import {
	ensureGuestHistoryKey,
	historyKeyOwner,
	readHistoryKeyState,
	type HistoryKeyApi,
	type HistoryKeyState
} from './historyKeyClient';

/** The guest's key state, after making the key when `onConversation`; never makes one elsewhere. */
export async function guestHistoryKeyState(
	api: HistoryKeyApi,
	deviceLabel: string,
	onConversation: boolean
): Promise<HistoryKeyState> {
	if (onConversation) await ensureGuestHistoryKey(api, deviceLabel);
	return readHistoryKeyState(api, historyKeyOwner(null));
}

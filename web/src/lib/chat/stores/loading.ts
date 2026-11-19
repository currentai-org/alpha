// SPDX-FileCopyrightText: 2018- The Hugging Face team
// SPDX-License-Identifier: Apache-2.0
// Modified by Current AI from huggingface/chat-ui.
import { derived, writable, type Writable } from "svelte/store";

// The conversations with a turn running in this tab, by id. One page-wide boolean let a turn still
// answering in one chat lock the composer of every other chat, a new one included, so a
// turn's busy state belongs to the conversation it runs in.
const running = writable<ReadonlySet<string>>(new Set());

/** Marks a turn running (or not) in conversation `id`; no other conversation's state changes. */
function setConversationLoading(id: string, on: boolean): void {
	running.update((ids) => {
		if (ids.has(id) === on) return ids;
		const next = new Set(ids);
		if (on) next.add(id);
		else next.delete(id);
		return next;
	});
}

/** Conversation `id`'s busy state as a store: reads and writes touch that conversation only. */
export function conversationLoading(id: string): Writable<boolean> {
	const busy = derived(running, (ids) => ids.has(id));
	return {
		subscribe: busy.subscribe,
		set: (on) => setConversationLoading(id, on),
		update: (fn) => {
			let current = false;
			busy.subscribe((value) => (current = value))();
			setConversationLoading(id, fn(current));
		},
	};
}

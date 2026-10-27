/**
 * Client-owned conversations sidebar store.
 *
 * SSR safety: this module exports a factory function and context helpers
 * (createConversationsStore / useConversationsStore). The store instance is
 * held inside Svelte component context (keyed by CONVERSATIONS_CONTEXT_KEY)
 * and is therefore per-request on the server and per-layout on the client.
 * There is NO module-level mutable $state, so concurrent SSR requests do not
 * share data.
 *
 * Seeding strategy: +layout.svelte calls init() whenever data.conversations
 * reference changes. The store performs a last-write-wins merge from the
 * server — local optimistic mutations (delete/rename/title) are intentionally
 * overwritten on the next server resync. This is acceptable because:
 *   - delete/rename mutations are immediately visible and the server round-trip
 *     is fast (< 500 ms typical);
 *   - title updates from streaming are ephemeral until the store is next
 *     refreshed, which happens after generation completes.
 * If we wanted to preserve local mutations across resyncs we would need to
 * track "dirty" ids — the complexity is not justified at this stage.
 *
 * One exception: `titleSource`. The server persists a title's text and never
 * its source, so a resync can only ever erase it, and the post-turn refresh
 * runs right after the Title update in almost every turn. The store remembers
 * the source per id alongside the title it described, and every list
 * replacement re-applies it where that title is still the one shown (CUR-1971).
 */

import { browser } from "$app/environment";
import { getContext, setContext } from "svelte";
import type { ConvSidebar } from "$lib/chat/types/ConvSidebar";
import type { TitleSource } from "$lib/chat/types/MessageUpdate";
import { useAPIClient, handleResponse } from "$lib/chat/APIClient";

export const CONVERSATIONS_CONTEXT_KEY = "conversationsStore";

interface ConversationListItem {
	_id: { toString(): string };
	title: string;
	updatedAt: Date | string;
	model?: string;
}

export class ConversationsStore {
	#list = $state<ConvSidebar[]>([]);
	/** Title sources seen this session, keyed by id, with the title each one described. */
	// Bookkeeping read only when a list is replaced; nothing renders from it, so it needn't be reactive.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#titleSources = new Map<string, { title: string; source: TitleSource }>();
	/** Conversations added here by prepend() that no server list has included yet. */
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	#prepended = new Map<string, ConvSidebar>();
	/** The last list the layout handed to init(), kept only to recognise it when it comes back. */
	#layoutList: ConvSidebar[] | undefined;

	get list(): ConvSidebar[] {
		return this.#list;
	}

	/**
	 * Replace the entire list (called from layout when data.conversations changes).
	 *
	 * `keepPrepended` is for a list the layout loaded earlier and hands over late. The shell's first
	 * load can resolve after the landing page has already prepended a conversation it just created,
	 * and since the layout no longer reruns on the move to that conversation (CUR-2350), nothing
	 * brings the entry back until the post-turn refresh. Keeping it leaves the new conversation in
	 * the rail for its whole first turn (CUR-2391). Every other caller, a wipe included, replaces
	 * the list outright.
	 */
	init(conversations: ConvSidebar[], { keepPrepended = false } = {}): void {
		// A navigation that reruns only the root layout (New chat's goto) hands back the chat layout's
		// page-load list, the very array applied before. Applied again it would undo every refresh
		// since and drop each chat made after the page loaded (CUR-2545). A fresh load is a new array.
		if (keepPrepended && conversations === this.#layoutList) return;
		if (keepPrepended) this.#layoutList = conversations;
		this.#list = this.#withTitleSources(this.#settlePrepended(conversations, keepPrepended));
	}

	/** Forget each prepend the list already holds; with `keep`, put the rest back on top. */
	#settlePrepended(list: ConvSidebar[], keep: boolean): ConvSidebar[] {
		if (!keep) {
			this.#prepended.clear();
			return list;
		}
		if (this.#prepended.size === 0) return list;
		for (const conv of list) this.#prepended.delete(String(conv.id));
		const missing = [...this.#prepended].map(
			([id, conv]) => this.#list.find((c) => String(c.id) === id) ?? conv
		);
		return [...missing, ...list];
	}

	/**
	 * Apply a partial patch to a single conversation by id.
	 * Silently ignores unknown ids (e.g. race between title update and delete), except that a
	 * title source is still remembered, so the entry picks it up once a resync brings it in.
	 */
	update(id: string, patch: Partial<Omit<ConvSidebar, "id">>): void {
		if (patch.titleSource && patch.title !== undefined) {
			this.#titleSources.set(id, { title: patch.title.trim(), source: patch.titleSource });
		}
		const idx = this.#list.findIndex((c) => String(c.id) === id);
		if (idx === -1) return;
		// A new array, not an element write: the side rail can hold its own copy of the list (NavMenu
		// reassigns its prop when infinite scroll runs), and a copy only follows a new array. Written in
		// place, a title reaches the header and leaves the rail on "New Chat" until the refresh (CUR-2379).
		this.#list = this.#list.map((conv, i) => (i === idx ? { ...conv, ...patch } : conv));
	}

	/** Re-attach a remembered source to each entry whose title is still the one it described. A
	 *  different title means something else renamed the conversation, so the source no longer applies. */
	#withTitleSources(list: ConvSidebar[]): ConvSidebar[] {
		if (this.#titleSources.size === 0) return list;
		return list.map((conv) => {
			const known = this.#titleSources.get(String(conv.id));
			if (!known || conv.titleSource || known.title !== conv.title.trim()) return conv;
			return { ...conv, titleSource: known.source };
		});
	}

	/** Remove a conversation by id (optimistic delete). */
	remove(id: string): void {
		this.#prepended.delete(id);
		this.#list = this.#list.filter((c) => String(c.id) !== id);
	}

	/** Prepend a new conversation to the top of the list. */
	prepend(conv: ConvSidebar): void {
		this.#prepended.set(String(conv.id), conv);
		this.#list = [conv, ...this.#list];
	}

	/**
	 * Re-fetch GET /api/v2/conversations?p=0 and reconcile with the local list.
	 * Performs a last-write-wins replace so updatedAt ordering reflects the server.
	 * No-op on the server (browser guard).
	 */
	async refresh(): Promise<void> {
		if (!browser) return;
		try {
			const client = useAPIClient();
			const data = (await client.conversations.get({ query: { p: 0 } }).then(handleResponse)) as {
				conversations: ConversationListItem[];
				hasMore: boolean;
			};

			const defaultModel = undefined; // caller can patch model separately if needed
			const freshList: ConvSidebar[] = data.conversations.map((conv) => ({
				id: conv._id.toString(),
				title: conv.title.trim(),
				model: conv.model ?? defaultModel,
				// A timestamp that is replaced, never mutated in place.
				// eslint-disable-next-line svelte/prefer-svelte-reactivity
				updatedAt: new Date(conv.updatedAt),
			}));
			this.#list = this.#withTitleSources(this.#settlePrepended(freshList, false));
		} catch (err) {
			// Non-fatal: keep the existing list rather than blanking the sidebar.
			console.error("[conversationsStore] refresh failed", err);
		}
	}
}

/** Call once in +layout.svelte to create and register the store in context. */
export function createConversationsStore(): ConversationsStore {
	const store = new ConversationsStore();
	setContext(CONVERSATIONS_CONTEXT_KEY, store);
	return store;
}

/** Call in any descendant component to access the store. */
export function useConversationsStore(): ConversationsStore {
	return getContext<ConversationsStore>(CONVERSATIONS_CONTEXT_KEY);
}

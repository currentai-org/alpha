<script lang="ts">
	import { base } from "$lib/chat/paths";
	import { Button } from "@aipotluck/alpha-ds";
	import { useAPIClient, handleResponse } from "$lib/chat/APIClient";
	import { useConversationsStore } from "$lib/chat/stores/conversations.svelte";
	import { error } from "$lib/chat/stores/errors";
	import DeleteConversationModal from "$lib/chat/components/DeleteConversationModal.svelte";
	import type { PageData } from "./$types";
	import { m } from "$lib/paraglide/messages.js";

	// Settings → Archived chats. Archiving takes a chat out of the sidebar without deleting
	// it; here it comes back (Unarchive) or goes for good (Delete, after the usual confirmation).
	let { data }: { data: PageData } = $props();

	type Row = { id: string; title: string; updatedAt: string };
	// Seeded from the load; later edits (unarchive, delete, load more) are this page's own.
	// svelte-ignore state_referenced_locally
	let rows = $state<Row[]>(data.archived);
	// svelte-ignore state_referenced_locally
	let hasMore = $state(data.hasMore);
	// Paging continues from the last row fetched, not from an offset: Unarchive and Delete shorten the
	// server's list, and an offset would then skip a row. Held apart from `rows` so removing the last
	// visible row cannot move it.
	// svelte-ignore state_referenced_locally
	let cursor = $state<Row | null>(data.archived.at(-1) ?? null);
	let deleting = $state<Row | null>(null);

	const client = useAPIClient();
	const convsStore = useConversationsStore();

	const when = (ts: string) =>
		new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

	async function unarchive(row: Row) {
		try {
			await client.conversations({ id: row.id }).patch({ archived: false }).then(handleResponse);
			rows = rows.filter((r) => r.id !== row.id);
			void convsStore?.refresh();
		} catch (err) {
			console.error(err);
			$error = m.product_unarchiveFailed();
		}
	}

	async function remove(row: Row) {
		try {
			await client.conversations({ id: row.id }).delete().then(handleResponse);
			rows = rows.filter((r) => r.id !== row.id);
		} catch (err) {
			console.error(err);
			$error = m.product_deleteFailed();
		}
	}

	async function loadMore() {
		if (!cursor) return;
		try {
			const res = (await client.conversations
				.get({ query: { archived: 1, beforeAt: new Date(cursor.updatedAt).getTime(), beforeId: cursor.id } })
				.then(handleResponse)) as {
				conversations: { _id: { toString(): string }; title: string; updatedAt: string | Date }[];
				hasMore: boolean;
			};
			const fetched = res.conversations.map((c) => ({
				id: c._id.toString(),
				title: c.title.trim(),
				updatedAt: new Date(c.updatedAt).toISOString(),
			}));
			hasMore = res.hasMore;
			cursor = fetched.at(-1) ?? cursor;
			rows = [...rows, ...fetched];
		} catch (err) {
			console.error(err);
			$error = m.product_loadMoreArchivedFailed();
		}
	}
</script>

<div class="flex flex-col gap-4">
	<p class="type-body text-fg-2">{m.product_archivedIntro()}</p>
	{#if rows.length > 0}
		<ul class="flex flex-col gap-2" aria-label={m.product_archivedChats()}>
			{#each rows as row (row.id)}
				<li
					class="flex flex-wrap items-center justify-between gap-3 border border-line-2 p-3 rounded-card"
					data-archived-chat={row.id}
				>
					<a class="min-w-0 flex-1 truncate type-body text-fg-1 hover:underline" href="{base}/conversation/{row.id}">
						{row.title}
					</a>
					<span class="type-caption text-fg-3">{when(row.updatedAt)}</span>
					<div class="flex gap-2">
						<Button size="sm" casing="sentence" onclick={() => unarchive(row)} data-unarchive>{m.product_unarchive()}</Button>
						<Button size="sm" casing="sentence" variant="destructive" onclick={() => (deleting = row)} data-archived-delete>
							{m.product_delete()}
						</Button>
					</div>
				</li>
			{/each}
		</ul>
	{:else if !hasMore}
		<p class="type-body text-fg-3" data-archived-empty>{m.product_archivedEmpty()}</p>
	{/if}
	<!-- Outside the list branch: unarchiving or deleting every loaded row must not hide the rest. -->
	{#if hasMore}
		<Button size="sm" casing="sentence" class="self-start" onclick={loadMore} data-archived-load-more>
			{m.product_loadMore()}
		</Button>
	{/if}
</div>

{#if deleting}
	<DeleteConversationModal
		open
		title={deleting.title}
		onclose={() => (deleting = null)}
		ondelete={() => {
			const row = deleting;
			deleting = null;
			if (row) void remove(row);
		}}
	/>
{/if}

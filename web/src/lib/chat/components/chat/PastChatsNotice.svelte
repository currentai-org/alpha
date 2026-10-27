<script lang="ts">
	import RiChatHistoryLine from '~icons/ri/chat-history-line';
	import AnswerNote from './AnswerNote.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import type { RagSource } from '$lib/chat/types/Rag';

	// This answer searched the person's own earlier chats (search_past_chats). The note names
	// each chat it read, one link per chat, so the person can see where an answer about the past came from. (CUR-4576)
	let { sources }: { sources: ReadonlyArray<Pick<RagSource, 'title' | 'url'>> } = $props();

	const chats = $derived(
		[...new Map(sources.filter((s) => s.url).map((s) => [s.url as string, s.title])).entries()].map(
			([url, title]) => ({ url, title })
		)
	);
</script>

<div data-testid="past-chats-note">
	<AnswerNote icon={RiChatHistoryLine} title={m.message_pastChatsTitle()} tone="info">
		<p>{m.message_pastChatsBody()}</p>
		<ul class="flex flex-col gap-0.5">
			{#each chats as chat (chat.url)}
				<li>
					<a class="underline decoration-line-3 underline-offset-2 hover:text-fg-1" href={chat.url}>{chat.title}</a>
				</li>
			{/each}
		</ul>
		<p><a class="underline decoration-line-3 underline-offset-2 hover:text-fg-1" href="{base}/settings/personalization">{m.message_pastChatsSettings()}</a></p>
	</AnswerNote>
</div>

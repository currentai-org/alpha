<script lang="ts">
	// The read-only view of a shared chat. Everything here comes from the snapshot the
	// server loaded, which holds the turns' text and the model id only. There is no composer: the
	// reader can start a chat of their own from the link under the turns.
	import { page } from '$app/state';
	import { base } from '$lib/chat/paths';
	import { Message, Stack } from '@aipotluck/alpha-ds';
	import MarkdownRenderer from '$lib/chat/components/chat/MarkdownRenderer.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const shared = $derived(data.shared);

	const modelName = $derived.by(() => {
		const models = (page.data as { models?: { id: string; name?: string; displayName?: string }[] })
			.models;
		const m = models?.find((x) => x.id === shared.model);
		return m?.displayName ?? m?.name ?? shared.model;
	});

	const sharedOn = $derived.by(() => {
		const d = new Date(shared.sharedAt);
		return Number.isNaN(d.getTime())
			? ''
			: d.toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' });
	});
</script>

<svelte:head>
	<title>{shared.title} — shared chat</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<div class="h-full overflow-y-auto" data-testid="shared-chat">
	<Stack gap="6" class="mx-auto w-full max-w-thread px-4 py-8">
		<header class="flex flex-col gap-2 border-b border-line-2 pb-4">
			<h1 class="type-heading text-fg-1">{shared.title}</h1>
			<p class="type-caption text-fg-2" data-testid="shared-chat-notice">
				{sharedOn
					? m.share_readOnlyNoticeDated({ date: sharedOn, model: modelName })
					: m.share_readOnlyNotice({ model: modelName })}
			</p>
		</header>

		{#each shared.turns as turn, i (i)}
			<Message.Root from={turn.from}>
				<Message.Content>
					{#if turn.from === 'assistant'}
						<MarkdownRenderer content={turn.content} />
					{:else}
						<p class="whitespace-pre-wrap break-words">{turn.content}</p>
					{/if}
				</Message.Content>
			</Message.Root>
		{/each}

		<footer class="flex flex-col gap-2 border-t border-line-2 pt-4">
			<a
				href="{base}/"
				class="self-start type-body text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-2"
			>
				Start your own chat
			</a>
		</footer>
	</Stack>
</div>

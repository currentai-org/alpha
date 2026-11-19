<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { base } from '$lib/chat/paths';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';
	import { pendingChatInput } from '$lib/chat/stores/pendingChatInput';
	import { Button, ComposerAccessory } from '@aipotluck/alpha-ds';
	import RiTimerLine from '~icons/ri/timer-line';

	// Conversation expiry, from day 23 of the 30: the date this chat goes, and the two ways to
	// keep what is in it. Export downloads every conversation as the Open WebUI file the account page
	// offers (signed in only: a guest has no account to export from). Continue asks the server for one
	// summary of this chat and opens a new chat with it in the composer, to edit before sending; nothing
	// is stored until it is sent, and this chat is left as it is.

	let {
		conversationId,
		expiresAt,
		leafId
	}: { conversationId: string; expiresAt: Date; leafId?: string } = $props();

	const date = $derived(
		new Date(expiresAt).toLocaleDateString(getLocale(), { day: 'numeric', month: 'long' })
	);
	let busy = $state(false);
	let errorText = $state('');

	async function continueInNewChat() {
		busy = true;
		errorText = '';
		try {
			// A sealed chat's words open only in this browser, so they go with the request, as share does.
			const { sealedReleaseForShare, SealedReleaseError } = await import(
				'$lib/chat/utils/sealedRequest'
			);
			const release = await sealedReleaseForShare(conversationId, historyKeyring.identity).catch(
				(e) => {
					if (e instanceof SealedReleaseError && e.reason === 'locked') {
						historyKeyring.askToUnlock();
						throw new Error(m.chat_expiryContinueLocked());
					}
					throw e;
				}
			);
			const r = await fetch(`${base}/api/v2/conversations/${conversationId}/continue`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ leafId, ...release })
			});
			if (!r.ok) {
				const body = (await r.json().catch(() => null)) as { message?: string } | null;
				throw new Error(body?.message ?? m.chat_expiryContinueFailed());
			}
			const { summary } = (await r.json()) as { summary: string };
			// Set only once the new chat is mounted: set before, this chat's own composer takes it and
			// clears the store, and the new chat opens empty.
			await goto(`${base}/`);
			pendingChatInput.set(summary);
		} catch (e) {
			errorText = (e as Error).message || m.chat_expiryContinueFailed();
		} finally {
			busy = false;
		}
	}
</script>

<ComposerAccessory.Notice icon={RiTimerLine} data-testid="conversation-expiry-banner">
	{m.chat_expiryTitle({ date })}
	{#if errorText}<span class="block text-fg-2" role="alert">{errorText}</span>{/if}
	{#snippet action()}
		<div class="flex items-center gap-1">
			{#if page.data.user}
				<Button
					href={`${base}/api/v2/export/open-webui`}
					download
					variant="ghost"
					size="sm"
					casing="sentence">{m.chat_expiryExportShort()}</Button
				>
			{/if}
			<Button
				variant="secondary"
				size="sm"
				casing="sentence"
				disabled={busy}
				onclick={continueInNewChat}
				>{busy ? m.chat_expiryContinueBusy() : m.chat_expiryContinue()}</Button
			>
		</div>
	{/snippet}
</ComposerAccessory.Notice>

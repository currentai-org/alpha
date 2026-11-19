<!--
  @component
  Stands in for a sealed message that did not open in this browser (stage 3).
  ChatMessage renders it in place of the whole message, so neither text nor ciphertext shows.

  - locked: this browser has not unlocked the history key. "Unlock" reopens stage 2's unlock prompt
    (HistoryKeyFlows) for a signed-in account where the key flows are on.
  - unreadable: the blob did not open for this message: another key, damage, or a blob moved here from
    another message or conversation. Nothing can be shown, and nothing is.
-->
<script lang="ts">
	import { page } from '$app/state';
	import { Button } from '@aipotluck/alpha-ds';
	import RiLockLine from '~icons/ri/lock-line';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';
	import AnswerNote from './AnswerNote.svelte';

	let {
		state,
		from,
		messageId
	}: {
		state: 'locked' | 'unreadable';
		from: 'user' | 'assistant' | 'system';
		messageId: string;
	} = $props();

	const unlockOffered = $derived(
		state === 'locked' && page.data.historyKeyEnabled === true && Boolean(page.data.user?.id)
	);
</script>

<div
	class="flex w-full {from === 'user' ? 'justify-end' : 'justify-start'}"
	data-message-id={messageId}
	data-message-role={from}
	data-sealed-state={state}
	data-testid="sealed-message"
>
	{#if state === 'locked'}
		<AnswerNote icon={RiLockLine} tone="info" title="This message is locked">
			{#snippet action()}
				{#if unlockOffered}
					<Button variant="secondary" size="xs" casing="sentence" onclick={() => historyKeyring.askToUnlock()}>
						Unlock your history
					</Button>
				{/if}
			{/snippet}
			<p>
				Your history is encrypted with a key only you hold. This browser hasn't opened that key yet, so
				it can't show this message. Unlock it with your recovery key or passkey.
			</p>
		</AnswerNote>
	{:else}
		<AnswerNote icon={RiErrorWarningLine} title="Can't open this message">
			<p>
				This message didn't open with your key, or it doesn't belong in this place in the chat, so it
				isn't shown.
			</p>
		</AnswerNote>
	{/if}
</div>

<script lang="ts">
	import { Button } from '@aipotluck/alpha-ds';
	import { historyKeyring } from '$lib/chat/crypto/historyKeyring.svelte';

	/**
	 * XRAY → "This answer": the prompt the model was sent for this answer, loaded on request. A sealed
	 * chat is opened in this browser and its opened words posted, so the server can rebuild the prompt
	 * it cannot read itself. A refusal is shown with its reason, never as an empty prompt.
	 */
	let { conversationId, messageId }: { conversationId: string; messageId: string } = $props();

	let phase = $state<'idle' | 'loading' | 'shown' | 'failed'>('idle');
	let prompt = $state('');
	let reason = $state('');

	// A different answer in the panel starts closed again.
	$effect(() => {
		void messageId;
		phase = 'idle';
		prompt = '';
		reason = '';
	});

	async function show() {
		phase = 'loading';
		const forMessage = messageId;
		try {
			// Loaded on click, so the API client stays out of this component's import graph.
			const { messagePrompt } = await import('$lib/chat/utils/sealedPrompt');
			const out = await messagePrompt(conversationId, forMessage, historyKeyring.identity);
			if (forMessage !== messageId) return;
			prompt = out.prompt;
			phase = 'shown';
		} catch (e) {
			if (forMessage !== messageId) return;
			reason = e instanceof Error ? e.message : 'The prompt could not be loaded.';
			phase = 'failed';
		}
	}
</script>

<div class="flex flex-col gap-2 border-t border-line-1 pt-3" data-prompt-view>
	<span class="type-label text-fg-3">The prompt behind this answer</span>
	{#if phase === 'shown'}
		<pre
			class="max-h-64 overflow-auto rounded-sharp border border-line-1 bg-surface-2 p-2 type-caption text-fg-2 whitespace-pre-wrap"
			data-prompt-text>{prompt}</pre>
	{:else}
		<div>
			<Button variant="secondary" size="sm" onclick={show} disabled={phase === 'loading'}>
				{phase === 'loading' ? 'Loading the prompt…' : 'Show the prompt'}
			</Button>
		</div>
		{#if phase === 'failed'}
			<p class="type-caption text-fg-2" role="alert" data-prompt-error>{reason}</p>
		{/if}
	{/if}
</div>

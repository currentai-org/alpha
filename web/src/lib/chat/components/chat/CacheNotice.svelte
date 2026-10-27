<script lang="ts">
	import RiWifiOffLine from '~icons/ri/wifi-off-line';
	import AnswerNote from './AnswerNote.svelte';
	import type { Message } from "$lib/chat/types/Message";

	// Honesty chip for the starter-cache fallback. When the time-to-first-token watchdog
	// gave up waiting for the live model (the request never reached the server) we render a
	// pre-vetted starter answer so the user isn't left staring at a dead spinner. This chip
	// makes that provenance explicit — it is NOT a fresh live generation — and offers the
	// one honest action: retry for a live answer once the connection is back. It reuses the
	// existing onretry seam (same one the footer Retry button uses), no new machinery.
	//
	// Driven by the TRANSIENT message.servedFromCache marker (see Message.ts): set only on the
	// client when the watchdog falls back, never persisted, so a reloaded conversation — which
	// re-fetches live — correctly stops showing it. The provenance stays truthful on reload.
	interface Props {
		message: Message;
		onretry?: (payload: { id: Message["id"]; content?: string }) => void;
	}
	let { message, onretry }: Props = $props();
</script>

<AnswerNote icon={RiWifiOffLine} title="Saved answer — you went offline before Alpha replied">
	{#snippet action()}
		{#if onretry}
			<button
				type="button"
				class="type-caption text-caution-text underline underline-offset-2 hover:text-fg-1"
				onclick={() => onretry?.({ id: message.id })}
			>
				Get a live answer
			</button>
		{/if}
	{/snippet}
	<p>
		Your connection dropped, so instead of leaving you waiting we showed a saved, pre-checked answer. It isn’t a fresh
		reply from the model — get a live one once you’re back online.
	</p>
</AnswerNote>

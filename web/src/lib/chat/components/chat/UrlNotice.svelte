<script lang="ts">
	import RiLinkUnlinkM from '~icons/ri/link-unlink-m';
	import AnswerNote from './AnswerNote.svelte';
	// Honest advisory shown when the post-generation URL guard ($lib/chat/server/urlGuard) flagged one or
	// more citation URLs the model emitted but we couldn't vouch for (not retrieved this turn, not a
	// recognised domain). Those URLs stay CLICKABLE in the answer but render dotted with a "?" marker;
	// this chip is the structured explanation the "?" superscripts point the eye toward. Mirrors
	// NameNotice / SafetyNotice (calm, muted, non-blocking — the answer above is real).
	interface Props {
		/** how many links were flagged */
		count: number;
		/** the original URLs (for the tooltip) */
		urls?: string[];
		/** briefly highlight when the user clicks the "?" marker in the answer above */
		flash?: boolean;
	}
	let { count, urls = [], flash = false }: Props = $props();
</script>

<AnswerNote
	icon={RiLinkUnlinkM}
	title={count === 1 ? "1 link in this answer couldn’t be checked" : `${count} links in this answer couldn’t be checked`}
	{flash}
>
	<p>
		Alpha wrote {count === 1 ? "this link" : "these links"} itself instead of finding {count === 1 ? "it" : "them"} in a source, so
		it couldn’t confirm the page exists or says what the answer claims. {count === 1 ? "It still works" : "They still work"}
		— look for the <span class="font-semibold text-caution-text">?</span> in the answer — but check before you rely on
		{count === 1 ? "it" : "them"}.
	</p>
	{#if urls.length}
		<ul class="flex flex-col gap-0.5">
			{#each urls as url (url)}
				<li class="truncate font-mono text-fg-3" title={url}>{url}</li>
			{/each}
		</ul>
	{/if}
</AnswerNote>

<script lang="ts">
	import { base } from '$lib/chat/paths';
	import { m } from '$lib/paraglide/messages.js';
	import { Button } from '@aipotluck/alpha-ds';
	import { getInvolvedDismissedAt, getInvolvedVisible, recentLanguageGap } from '$lib/chat/routing/state';
	import PotluckMark from './PotluckMark.svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';

	/**
	 * The sidebar's "Get involved" card, above the account row: Alpha is assembled from open parts,
	 * and its gaps are where people can help. Links to Settings → Contribute. Closing it hides it on
	 * this device for a few days (GET_INVOLVED_RETURN_MS), then it comes back. Hidden in the collapsed
	 * rail, where there is no room to read it.
	 *
	 * Motion, all of it off under reduced motion: the card rises in when it appears, and every few
	 * seconds the mark's four diamonds lift one after another and the arrow nudges toward the link.
	 */
	const gap = $derived($recentLanguageGap);
	// Read once per mount: a card closed days ago comes back on the next page load, not mid-session.
	const now = Date.now();
</script>

{#if getInvolvedVisible($getInvolvedDismissedAt, now)}
	<aside
		aria-label={m.chat_getInvolvedTitle()}
		class="get-involved relative mx-2 mb-2 flex shrink-0 flex-col gap-2 border border-line-2 bg-surface-raised p-3 rounded-card md:group-data-collapsed/sidebar:hidden"
		data-get-involved
	>
		<div class="flex items-center gap-2 pr-6">
			<PotluckMark class="size-4 shrink-0" />
			<h2 class="type-label text-fg-1">{m.chat_getInvolvedTitle()}</h2>
		</div>
		<p class="type-caption text-fg-2">
			{#if gap}
				{m.chat_getInvolvedGap({ language: gap.name })}
			{:else}
				{m.chat_getInvolvedBody()}
			{/if}
		</p>
		<Button href={`${base}/settings/contribute`} variant="secondary" size="sm" casing="sentence" class="self-start" data-get-involved-link>
			{m.chat_waysToContribute()} <span class="get-involved-arrow flex"><RiArrowRightLine aria-hidden="true" /></span>
		</Button>
		<Button
			variant="ghost"
			size="icon-xs"
			class="absolute top-2 right-2"
			aria-label={m.chat_getInvolvedDismiss()}
			onclick={() => getInvolvedDismissedAt.set(Date.now())}
			data-get-involved-dismiss
		>
			<RiCloseLine aria-hidden="true" />
		</Button>
	</aside>
{/if}

<style>
	@media (prefers-reduced-motion: no-preference) {
		.get-involved {
			animation: get-involved-in 480ms var(--ds-ease-standard) both;
		}
		/* The four diamonds lift in turn, the potluck coming together, then the arrow points the way. */
		.get-involved :global([data-potluck-mark] path) {
			transform-box: fill-box;
			transform-origin: center;
			animation: get-involved-lift 7s var(--ds-ease-standard) infinite;
		}
		.get-involved :global([data-potluck-mark] path:nth-child(2)) {
			animation-delay: 90ms;
		}
		.get-involved :global([data-potluck-mark] path:nth-child(3)) {
			animation-delay: 180ms;
		}
		.get-involved :global([data-potluck-mark] path:nth-child(4)) {
			animation-delay: 270ms;
		}
		.get-involved-arrow {
			animation: get-involved-nudge 7s var(--ds-ease-standard) infinite;
			animation-delay: 300ms;
		}
	}
	@keyframes get-involved-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes get-involved-lift {
		0%,
		8%,
		100% {
			transform: none;
		}
		4% {
			transform: scale(1.22);
		}
	}
	@keyframes get-involved-nudge {
		0%,
		6%,
		14%,
		100% {
			transform: none;
		}
		10% {
			transform: translateX(3px);
		}
	}
</style>

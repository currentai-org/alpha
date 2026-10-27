<script lang="ts">
	import { onMount } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { Button } from '@aipotluck/alpha-ds';
	import { tour } from '$lib/chat/tour/tour.svelte';
	import RiCloseLine from '~icons/ri/close-line';
	import RiCompass3Line from '~icons/ri/compass-3-line';

	/**
	 * After a skipped welcome: a note directly above the sidebar's account row, its pointer on the
	 * avatar, saying the tour is in that menu. It goes once the person closes it, opens the account
	 * menu or takes the tour (tour.svelte.ts keeps it per device). Hidden in the collapsed rail, where
	 * there is no room to read it; the welcome's caller covers that case with a toast.
	 */
	onMount(() => tour.restoreHint());
</script>

{#if tour.hint}
	<aside
		aria-label={m.tour_hintLabel()}
		class="tour-hint relative mx-2 mb-2 flex shrink-0 items-start gap-2 border border-line-2 bg-surface-raised py-2.5 pr-9 pl-3 rounded-card md:group-data-collapsed/sidebar:hidden"
		data-tour-hint
	>
		<RiCompass3Line aria-hidden="true" class="mt-px size-4 shrink-0 text-accent-1" />
		<p class="type-caption text-fg-2">{m.tour_hint()}</p>
		<Button
			variant="ghost"
			size="icon-xs"
			class="absolute top-1.5 right-1.5"
			aria-label={m.tour_hintDismiss()}
			onclick={() => tour.dismissHint()}
			data-tour-hint-dismiss
		>
			<RiCloseLine aria-hidden="true" />
		</Button>
		<span class="tour-hint-pointer border-line-2 bg-surface-raised" aria-hidden="true"></span>
	</aside>
{/if}

<style>
	/* A notch on the card's lower edge, over the account row's avatar below it. */
	.tour-hint-pointer {
		position: absolute;
		bottom: -5px;
		left: 14px;
		width: 9px;
		height: 9px;
		border-right-width: 1px;
		border-bottom-width: 1px;
		transform: rotate(45deg);
	}
	@media (prefers-reduced-motion: no-preference) {
		.tour-hint {
			animation: tour-hint-in 480ms var(--ds-ease-standard) both;
		}
	}
	@keyframes tour-hint-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
</style>

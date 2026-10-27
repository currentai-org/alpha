<script lang="ts">
	import { contributeOpen } from "$lib/chat/stores/contribute";
	import type { StarterGap } from "$lib/chat/constants/starterGaps";
	import { gapCardCopy } from "$lib/chat/chromeCopy";
	import PotluckMark from "../PotluckMark.svelte";
	import RiArrowRightLine from "~icons/ri/arrow-right-line";

	// "This answer touches a gap in the open stack → get involved." Shown under an answer
	// whose originating prompt deliberately surfaces a known gap (see starterGaps). Two
	// honest actions, both reusing existing seams: pulse + deep-link the gap's node on the
	// live-stack map (the same `ap:flash` CustomEvent SafetyBadge/SourceStrip use), and open
	// the contribution form prefilled with the gap's ask (the contributeOpen { topic } seam
	// the live-stack map's own gap nodes already use). No new machinery.
	interface Props {
		gap: StarterGap;
		/** The visitor's chrome language (chromeCopy.ts); the card follows it when it has a translation. */
		lang?: string;
	}
	let { gap, lang = "en" }: Props = $props();
	const card = $derived(gapCardCopy(lang, gap.node, gap.ask));

	const flash = () =>
		window.dispatchEvent(new CustomEvent("ap:flash", { detail: { ids: [gap.node] } }));

	const getInvolved = () => {
		flash();
		contributeOpen.set({ topic: gap.ask, node: gap.node });
	};
</script>

<!-- A quiet caption line under the answer, styled like the provenance footer beneath it (maker ·
     model · How this was made): same type, same muted ink, an underlined link as the one action. The
     Potluck mark says whose invitation this is. Neutral, never gap-red — in the chat red reads as an
     error (red is reserved for the safety/decline signal).
     CUR-1873: it is an invitation, not a fact about the answer, so it is marked as a note of its own
     and never shares a line with the provenance readout. -->
<div
	role="note"
	aria-label={card.copy.gapAria}
	class="mt-3 flex max-w-xl flex-wrap items-center gap-x-1.5 gap-y-0.5 type-caption text-fg-3"
	title={card.copy.gapTitle}
	data-gap-invite
>
	<PotluckMark class="size-3.5 shrink-0" />
	<span>{card.copy.gapLabel}</span>
	<span aria-hidden="true">·</span>
	<span class="min-w-0">{card.line}</span>
	<!-- One CTA: it flashes the gap's node AND opens the prefilled contribution form. -->
	<button
		type="button"
		onclick={getInvolved}
		class="inline-flex items-center gap-1 underline decoration-line-3 underline-offset-2 transition-control hover:text-fg-1"
	>
		{card.copy.gapAction} <RiArrowRightLine aria-hidden="true" class="size-3.5" />
	</button>
</div>

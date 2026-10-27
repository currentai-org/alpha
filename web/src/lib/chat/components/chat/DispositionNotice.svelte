<script lang="ts">
	import RiChatCheckLine from '~icons/ri/chat-check-line';
	import AnswerNote from './AnswerNote.svelte';
	// Honest response-disposition chip — names what the model actually DID when its answer isn't a clean
	// answer (it declined on its own, stated a limit about itself, or asked for clarification). The model
	// RAN and produced this — it is NOT a safety-layer block (that path is moderation.flagged, surfaced
	// separately). The single source for the disposition + copy is $lib/chat/utils/responseDisposition, read via
	// provenanceFacts, so this chip, the inline trace, and the request-log view all agree. Copy is placeholder
	// pending review.
	import { DISPOSITION_COPY, type ResponseDisposition } from "$lib/chat/utils/responseDisposition";
	import { m } from "$lib/paraglide/messages.js";
	import { trackEvent } from "$lib/analytics";

	interface Props {
		disposition: ResponseDisposition;
		// Analytics-only: 1-indexed turn position.
		turnNumber?: number;
	}
	let { disposition, turnNumber }: Props = $props();

	// Fires once per message: `disposition` is fixed at message-creation time (never flips back
	// and forth), so a plain mount-time effect can't double-count on this component's lifetime.
	let tracked = false;
	$effect(() => {
		if (disposition !== "answered" && !tracked) {
			tracked = true;
			trackEvent("sycophancy_notice_shown", { turn_number: turnNumber });
		}
	});

	// The chip's text in the interface language (the "why was this declined" copy). Keyed by disposition.
	const CHIP_TEXT: Record<Exclude<ResponseDisposition, "answered">, () => string> = {
		"self-declined": m.copy_declineSelf,
		"capability-disclaimer": m.copy_declineCapability,
		clarification: m.copy_declineClarification,
	};
	// never rendered for "answered" (caller gates), but narrow the type for DISPOSITION_COPY indexing
	let copy = $derived(disposition === "answered" ? null : DISPOSITION_COPY[disposition]);
	let chipText = $derived(
		disposition === "answered"
			? ""
			: CHIP_TEXT[disposition]() || DISPOSITION_COPY[disposition].chip
	);
</script>

{#if copy}
	<AnswerNote icon={RiChatCheckLine} tone="info" title={chipText}>
		<p>The model wrote this reply itself — no safety filter stepped in. You can rephrase or add detail and try again.</p>
	</AnswerNote>
{/if}

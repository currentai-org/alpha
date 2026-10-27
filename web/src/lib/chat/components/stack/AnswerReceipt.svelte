<script lang="ts">
	import type { Message } from '$lib/chat/types/Message';
	import { provenanceFacts } from '$lib/chat/utils/trace/provenanceFacts';
	import { catalogByGatewayId } from '$lib/chat/routing/catalog';
	import { servedModelId } from '$lib/chat/identity';
	import { ranOn } from '$lib/chat/provenanceLine';
	import { deriveMessageStatus } from '$lib/chat/utils/generationState';
	import ProvenanceBreakdown from '../provenance/ProvenanceBreakdown.svelte';
	import { useShowServing } from '$lib/chat/stores/showServing.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { mcpCallWhat } from './mcpCallCopy';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiSearchLine from '~icons/ri/search-line';
	import RiCheckDoubleLine from '~icons/ri/check-double-line';

	/**
	 * XRAY → "This answer": a plain-language receipt for the latest answer, in the order things
	 * happened — safety check, lookups, who made and ran the model, where your data is kept, any
	 * second opinion. Every line comes from `provenanceFacts` (the same facts the inline trace uses),
	 * so the two can't disagree; nothing is claimed that the turn didn't record.
	 */
	let {
		message,
		conversationModelId,
		signedIn = false,
		attachedFiles = []
	}: {
		message?: Message;
		conversationModelId: string;
		signedIn?: boolean;
		/** Names of the files on the question this answer replies to. */
		attachedFiles?: string[];
	} = $props();

	const facts = $derived(message ? provenanceFacts(message) : undefined);
	// The person may hide which model answered and where it ran; the line says so instead. (CUR-549)
	const serving = useShowServing();
	// A turn that failed before any answer arrived has nothing to describe (CUR-2812). Without this the
	// receipt read "Answered from what the model already knows" about a turn that never answered.
	const failedBeforeAnswer = $derived(
		!!message && deriveMessageStatus(message) === 'error' && !message.content?.trim()
	);
	// Only a router signal says which model answered (servedModelId); with none, no model is named.
	const servedId = $derived(message ? servedModelId(message.routerMetadata, conversationModelId) : undefined);

	const safety = $derived.by(() => {
		if (!facts) return '';
		if (facts.declined) return m.message_receiptDeclined();
		switch (facts.screen) {
			case 'clear':
				return m.message_receiptSafetyClear();
			case 'failed-open':
				return m.message_receiptSafetyFailedOpen();
			default:
				return m.message_stepSafetyNone();
		}
	});

	const lookups = $derived.by(() => {
		if (!facts) return [] as string[];
		const out: string[] = [];
		// A file the visitor attached is something the answer read. Without it a turn answered
		// from that file alone read "nothing was looked up". (CUR-4150)
		for (const name of attachedFiles) out.push(m.message_receiptAttached({ name }));
		if (facts.webCount)
			out.push(facts.webCount === 1 ? m.message_receiptWebOne() : m.message_receiptWebMany({ count: facts.webCount }));
		for (const hit of facts.ragHits) {
			const label = hit.label.charAt(0).toUpperCase() + hit.label.slice(1);
			out.push(
				hit.count === 1
					? m.message_receiptPassagesOne({ source: label })
					: m.message_receiptPassagesMany({ source: label, count: hit.count })
			);
		}
		if (facts.vault) out.push(m.message_receiptVault());
		if (facts.toolLookup) out.push(m.message_receiptTools());
		// A call to an MCP server, the operator's or the person's own, named with what came of it.
		// Without it a turn answered from such a tool read "nothing was looked up". (CUR-4038)
		for (const call of message?.mcpCalls ?? []) out.push(mcpCallWhat(call));
		if (!out.length) {
			// `searchAttempted` also covers a search the decider declined; only `searchRan` means one ran.
			out.push(
				facts.searchFailed
					? m.message_receiptSearchUnfinished()
					: facts.searchRan
						? m.message_receiptSearchNothing()
						: facts.searchAttempted
							? m.message_receiptSearchSkipped()
							: m.message_receiptNoLookup()
			);
		}
		return out;
	});
</script>

{#if !message || !facts}
	<p class="type-body text-fg-2">
		{m.message_receiptEmpty()}
	</p>
{:else if failedBeforeAnswer}
	<p class="type-body text-fg-2" data-provenance="failed">
		This turn failed before any answer arrived, so no model wrote anything and there is nothing to
		describe. Retry under the message to try again.
	</p>
{:else if facts.servedFromCache}
	<p class="type-body text-fg-2">
		{m.message_receiptCached()}
	</p>
{:else}
	<ol class="flex flex-col gap-5" data-answer-receipt>
		<li class="flex gap-3">
			<RiShieldCheckLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
			<div class="flex flex-col gap-0.5">
				<span class="type-label text-fg-3">{m.message_receiptSafety()}</span>
				<span class="type-body text-fg-2" data-receipt-safety>{safety}</span>
			</div>
		</li>
		{#if !facts.declined}
			<li class="flex gap-3">
				<RiSearchLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
				<div class="flex flex-col gap-0.5">
					<span class="type-label text-fg-3">{m.message_receiptLookedUp()}</span>
					{#each lookups as line, i (i)}<span class="type-body text-fg-2">{line}</span>{/each}
				</div>
			</li>
			<li>
				{#if !serving.current}
					<p class="type-body text-fg-2" data-provenance="hidden">
						{m.message_servingHidden()}
					</p>
				{:else if servedId}
					<ProvenanceBreakdown
						model={catalogByGatewayId(servedId)}
						mode="answer"
						ran={ranOn(message.routerMetadata?.backend, message.routerMetadata?.provider)}
						{signedIn}
					/>
				{:else}
					<p class="type-body text-fg-2" data-provenance="unavailable">
						{m.message_receiptNoModel()}
					</p>
				{/if}
			</li>
			{#if facts.verified}
				<li class="flex gap-3">
					<RiCheckDoubleLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
					<div class="flex flex-col gap-0.5">
						<span class="type-label text-fg-3">{m.message_secondOpinion()}</span>
						<span class="type-body text-fg-2">{m.message_receiptSecondOpinion()}</span>
					</div>
				</li>
			{/if}
		{/if}
	</ol>
{/if}

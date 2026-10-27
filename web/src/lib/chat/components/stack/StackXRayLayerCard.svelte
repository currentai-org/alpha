<script lang="ts">
	import type { StackXRayLayer } from './stackXRayLayers';
	import { plainPart } from './stackPlainLanguage';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import { Favicon } from '@aipotluck/alpha-ds';
	import { faviconSrc } from '$lib/favicon';

	/**
	 * One part of Alpha's stack, in plain words: an emoji, a friendly name, what it does, and its
	 * state. `expanded` (used by this answer, or lit by the live reveal) shows it as active; tapping
	 * the row reveals who builds it and the open project behind it. `answered` says an answer is on
	 * screen, so a working part it skipped reads as not used rather than as busy (CUR-2850).
	 */
	interface Props {
		layer: StackXRayLayer;
		expanded: boolean;
		pulsing?: boolean;
		answered?: boolean;
	}
	let { layer, expanded, pulsing = false, answered = false }: Props = $props();

	const part = $derived(plainPart(layer.name));
	let open = $state(false);

	// A serving row the maker's own API stood in for, or one the answer recorded nothing about, says
	// why rather than reading as a confident "Not used" (CUR-3966).
	const note = $derived(
		expanded
			? undefined
			: layer.unreported
				? 'This answer didn’t record which computers ran it.'
				: layer.bypassedBy
					? `${layer.bypassedBy} ran this answer directly.`
					: undefined
	);

	// Agent mode reads as unavailable, not absent, for someone its flag doesn't clear (CUR-1447).
	const chip = $derived(
		layer.available === false
			? { label: 'Not switched on for you', cls: 'bg-tint-subtle text-fg-3' }
			: expanded
				? { label: 'Used for this answer', cls: 'bg-xray-tint text-xray-glow' }
				: layer.unreported
					? { label: 'Not reported', cls: 'border border-dashed border-line-2 text-fg-3' }
					: layer.bypassedBy
						? { label: 'Skipped for this answer', cls: 'bg-tint-subtle text-fg-3' }
						: layer.status === 'live'
							? answered
								? { label: 'Not used for this answer', cls: 'bg-tint-subtle text-fg-3' }
								: layer.idle
									? { label: 'Not in use right now', cls: 'bg-tint-subtle text-fg-3' }
									: { label: 'Working', cls: 'bg-tint-subtle text-fg-2' }
							: layer.status === 'building'
								? { label: 'Being built', cls: 'bg-caution/15 text-caution-text' }
								: { label: 'Missing — help wanted', cls: 'bg-accent-1/15 text-accent-1-text' }
	);
</script>

<!-- data-used: this answer used the part (or the live reveal lit it); the row's detail opens on tap. -->
<li data-product-id={layer.name} data-used={expanded || undefined} class="list-none">
	<div
		class="border rounded-card transition-control {expanded
			? 'border-xray-line bg-xray-tint'
			: 'border-line-surface'} {pulsing ? 'motion-safe:animate-pulse' : ''}"
	>
		<button
			type="button"
			class="flex w-full items-center gap-3 px-3 py-2.5 text-left"
			aria-expanded={open}
			onclick={() => (open = !open)}
		>
			<span class="text-subhead leading-none" aria-hidden="true">{layer.emoji}</span>
			<span class="flex min-w-0 flex-1 flex-col">
				<span class="type-body text-fg-1">{part.name}</span>
				{#if part.what}<span class="type-caption text-fg-2">{part.what}</span>{/if}
				{#if note}<span class="type-caption text-fg-3" data-layer-note>{note}</span>{/if}
			</span>
			<span class="shrink-0 px-2 py-0.5 type-caption whitespace-nowrap rounded-pill {chip.cls}">{chip.label}</span>
			<RiArrowRightSLine aria-hidden="true" class="size-4 shrink-0 text-fg-3 {open ? 'rotate-90' : ''}" />
		</button>
		{#if open}
			<div class="flex flex-col gap-1.5 border-t border-line-surface px-3 py-2.5 pl-10 type-caption text-fg-3">
				{#if layer.osProduct || layer.partner}
					<p>
						{#if layer.osProduct}
							Built on
							{#if layer.osProductUrl}
								<a
									href={layer.osProductUrl}
									target={layer.osProductUrl.startsWith('/') ? undefined : '_blank'}
									rel={layer.osProductUrl.startsWith('/') ? undefined : 'noopener noreferrer'}
									class="text-fg-1 underline underline-offset-2">{layer.osProduct}</a
								>
							{:else}<span class="text-fg-1">{layer.osProduct}</span>{/if}
						{/if}
						<!-- A product that is its own maker ("Swiss National Supercomputing Centre") would
						     otherwise read "X by X". -->
						{#if layer.partner && layer.partner !== layer.osProduct}
							{layer.osProduct ? 'by' : 'By'}
							{#if layer.partnerLink}
								<a
									href={layer.partnerLink}
									target={layer.partnerLink.startsWith('/') ? undefined : '_blank'}
									rel={layer.partnerLink.startsWith('/') ? undefined : 'noopener noreferrer'}
									class="text-fg-1 underline underline-offset-2"
									data-xray-partner>{layer.partner}</a
								>
							{:else}<span class="text-fg-1" data-xray-partner>{layer.partner}</span>{/if}
						{/if}
						{#if layer.location}· {layer.location}{/if}
					</p>
				{/if}
				{#if layer.provenance ?? layer.desc}<p>{layer.provenance ?? layer.desc}</p>{/if}
				{#if layer.status === 'gap'}
					<p class="text-fg-1">No open option fills this part yet — it’s one of the gaps AI Potluck is working to close.</p>
				{/if}
				{#if layer.provenanceLinks?.length}
					<div class="flex flex-wrap gap-x-4">
						{#each layer.provenanceLinks as link (link.url)}
							<a href={link.url} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-fg-1 underline underline-offset-2">
								<Favicon src={faviconSrc(link.url)} size="xs" class="mr-0.5" />{link.label}<RiArrowRightUpLine aria-hidden="true" class="size-3" />
							</a>
						{/each}
					</div>
				{/if}
				{#if layer.ownLink}
					<a href={layer.ownLink.href} class="self-start text-fg-1 underline underline-offset-2" data-xray-own-link>{layer.ownLink.label}</a>
				{/if}
				{#if layer.mapHref}
					<a href={layer.mapHref} target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 self-start text-fg-1 underline underline-offset-2">
						See on the gap map<RiArrowRightUpLine aria-hidden="true" class="size-3" />
					</a>
				{/if}
			</div>
		{/if}
	</div>
</li>

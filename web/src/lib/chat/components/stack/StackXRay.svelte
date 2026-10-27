<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { prefersReducedMotion } from 'svelte/motion';
	import type { Message } from '$lib/chat/types/Message';
	import { MODEL_NODES, backendComputeNode, computeRevealStages } from './reveal';
	import { deriveStackXRayLayers } from './stackXRayLayers';
	import StackXRayLayerCard from './StackXRayLayerCard.svelte';
	import { STACK_GROUPS, plainPart } from './stackPlainLanguage';
	import { stackNodesToProductIds } from './stackXRayLive';
	import WhereItWent from './WhereItWent.svelte';

	interface Props {
		/** True while a turn is streaming — drives turn-end staged reveal. */
		active?: boolean;
		messages?: Message[];
		/** layoutData.ts's `agentEnabled` (agentModeEnabledForUser(locals)) — resolved server-side,
		 *  where user context exists, and passed down as a plain boolean. Never read as a flag here
		 *  (CUR-1447): this component has no `locals` to decide availability with, only the caller does. */
		agentAvailable?: boolean;
		/** layoutData.ts's `autoRoutingEnabled`, passed down the same way. */
		autoAvailable?: boolean;
		/** layoutData.ts's `storageRegion`: the region label of the database, for "Where your last
		 *  message went" (CUR-4580). */
		storageRegion?: string | null;
	}
	let { active = false, messages = [], agentAvailable = false, autoAvailable = false, storageRegion = null }: Props = $props();

	const lastAnswer = $derived([...messages].reverse().find((m) => m.from === 'assistant'));
	const layers = $derived(deriveStackXRayLayers(lastAnswer, { agentAvailable, autoAvailable }));
	// Grouped by what each part does for you (stackPlainLanguage.ts), in the roadmap's order.
	const groups = $derived(
		STACK_GROUPS.map((g) => ({ ...g, layers: layers.filter((l) => plainPart(l.name).group === g.id) }))
	);
	const usedCount = $derived(layers.filter((l) => l.touched).length);
	const gapCount = $derived(layers.filter((l) => l.status === 'gap').length);

	// Stack-map node ids currently highlighted (flash / staged turn-end reveal).
	let trailNodeIds = $state<string[]>([]);
	// Transient beat from ap:flash (700ms).
	let beatNodeIds = $state<Set<string>>(new Set());
	let beatTimer: ReturnType<typeof setTimeout> | undefined;
	// Sustained pulse from ap:pulse-on/off during streaming.
	let pulseNodeIds = $state<Set<string>>(new Set());
	const PULSE_OFF_DEBOUNCE_MS = 120;
	// Imperative pulse bookkeeping, deliberately NOT reactive — the pulse is driven by explicit
	// emit calls, and re-rendering on every add/delete is the thing being avoided.
	// eslint-disable-next-line svelte/prefer-svelte-reactivity
	let pendingOff = new Set<string>();
	let offTimer: ReturnType<typeof setTimeout> | undefined;

	let revealTimers: ReturnType<typeof setTimeout>[] = [];
	const clearReveal = () => {
		revealTimers.forEach(clearTimeout);
		revealTimers = [];
	};

	let listEl = $state<HTMLElement | undefined>();

	const scrollProductIntoView = (productId: string | undefined) => {
		if (!productId || !listEl) return;
		const el = listEl.querySelector<HTMLElement>(`[data-product-id="${productId}"]`);
		if (!el) return;
		const elRect = el.getBoundingClientRect();
		const cRect = listEl.getBoundingClientRect();
		const delta = elRect.top - cRect.top - (listEl.clientHeight - el.clientHeight) / 2;
		listEl.scrollBy({ top: delta, behavior: 'smooth' });
	};

	const stagedReveal = (nodeIds: string[]) => {
		clearReveal();
		const productIds = stackNodesToProductIds(nodeIds);
		if (prefersReducedMotion.current) {
			trailNodeIds = nodeIds;
			scrollProductIntoView(productIds.at(-1));
			return;
		}
		trailNodeIds = [];
		nodeIds.forEach((nodeId, i) => {
			revealTimers.push(
				setTimeout(() => {
					trailNodeIds = nodeIds.slice(0, i + 1);
					scrollProductIntoView(stackNodesToProductIds([nodeId])[0]);
				}, i * 460)
			);
		});
	};

	const trailProductIds = $derived(stackNodesToProductIds(trailNodeIds));
	const beatProductIds = $derived(stackNodesToProductIds(beatNodeIds));
	const pulseProductIds = $derived(stackNodesToProductIds(pulseNodeIds));

	function isHighlighted(name: string): boolean {
		const touched = layers.find((l) => l.name === name)?.touched ?? false;
		return (
			touched ||
			trailProductIds.includes(name) ||
			beatProductIds.includes(name) ||
			pulseProductIds.includes(name)
		);
	}

	function isPulsing(name: string): boolean {
		return beatProductIds.includes(name) || pulseProductIds.includes(name);
	}

	onMount(() => {
		const onFlash = (e: Event) => {
			clearReveal();
			const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? [];
			trailNodeIds = ids;
			beatNodeIds = new Set(ids);
			clearTimeout(beatTimer);
			beatTimer = setTimeout(() => (beatNodeIds = new Set()), 700);
			requestAnimationFrame(() => scrollProductIntoView(stackNodesToProductIds(ids).at(-1)));
		};

		const onPulseOn = (e: Event) => {
			const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? [];
			if (!ids.length) return;
			ids.forEach((id) => pendingOff.delete(id));
			// Local diff set, scoped to this call.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(pulseNodeIds);
			ids.forEach((id) => next.add(id));
			pulseNodeIds = next;
		};

		const onPulseOff = (e: Event) => {
			const ids = (e as CustomEvent<{ ids: string[] }>).detail?.ids ?? [];
			if (!ids.length) {
				pendingOff.clear();
				clearTimeout(offTimer);
				pulseNodeIds = new Set();
				return;
			}
			ids.forEach((id) => pendingOff.add(id));
			clearTimeout(offTimer);
			offTimer = setTimeout(() => {
				if (!pendingOff.size) return;
				// Local diff set, scoped to this call.
		// eslint-disable-next-line svelte/prefer-svelte-reactivity
		const next = new Set(pulseNodeIds);
				pendingOff.forEach((id) => next.delete(id));
				pendingOff.clear();
				pulseNodeIds = next;
			}, PULSE_OFF_DEBOUNCE_MS);
		};

		window.addEventListener('ap:flash', onFlash);
		window.addEventListener('ap:pulse-on', onPulseOn);
		window.addEventListener('ap:pulse-off', onPulseOff);

		return () => {
			clearReveal();
			clearTimeout(beatTimer);
			clearTimeout(offTimer);
			window.removeEventListener('ap:flash', onFlash);
			window.removeEventListener('ap:pulse-on', onPulseOn);
			window.removeEventListener('ap:pulse-off', onPulseOff);
		};
	});

	// Turn start/end: staged reveal on finish (ported from StackMap).
	let wasActive = false;
	$effect(() => {
		const isActive = active;
		untrack(() => {
			if (isActive) {
				clearReveal();
				wasActive = true;
				if (trailNodeIds.length === 0) {
					scrollProductIntoView(stackNodesToProductIds(MODEL_NODES)[0]);
				}
				return;
			}
			if (!wasActive) return;
			wasActive = false;
			pendingOff.clear();
			clearTimeout(offTimer);
			if (pulseNodeIds.size) pulseNodeIds = new Set();
			const answer = [...messages].reverse().find((m) => m.from === 'assistant');
			if (!answer) return;
			stagedReveal(
				computeRevealStages(answer, {
					computeNode: backendComputeNode(answer.routerMetadata?.backend)
				})
			);
		});
	});
</script>

<div class="flex h-full flex-col overflow-hidden">

	<div bind:this={listEl} class="scrollbar-custom scroll-fade-y flex-1 overflow-y-auto py-3 pr-4 pl-1" data-stack-list>
		{#if lastAnswer && !active}
			<WhereItWent answer={lastAnswer} {storageRegion} />
		{/if}
		<!-- One plain sentence first: how many parts, how many this answer used, how many are missing. -->
		<p class="mb-4 type-body text-fg-1" data-stack-summary>
			Alpha is built from {layers.length} parts.
			{#if usedCount}<span class="font-medium">{usedCount} helped with your last answer.</span>{/if}
			{#if gapCount}{gapCount} {gapCount === 1 ? 'is' : 'are'} still missing — gaps the community is working to fill.{/if}
		</p>
		{#each groups as group (group.id)}
			{#if group.layers.length}
				<section class="mb-5" aria-labelledby="stack-group-{group.id}">
					<h3 id="stack-group-{group.id}" class="type-label text-fg-2">{group.label}</h3>
					<p class="mb-2 type-caption text-fg-3">{group.blurb}</p>
					<ul class="flex flex-col gap-1.5">
						{#each group.layers as layer (layer.name)}
							<StackXRayLayerCard
								{layer}
								expanded={isHighlighted(layer.name)}
								pulsing={isPulsing(layer.name)}
								answered={!!lastAnswer}
							/>
						{/each}
					</ul>
				</section>
			{/if}
		{/each}
	</div>
</div>

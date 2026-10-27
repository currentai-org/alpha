<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';
	import type { Message } from '$lib/chat/types/Message';
	import { page } from '$app/state';
	import { Tabs } from '@aipotluck/alpha-ds';
	import { xrayMessageId, xraySecondOpinion } from '$lib/chat/stores/stack';
	import AnswerReceipt from './AnswerReceipt.svelte';
	import StackXRay from './StackXRay.svelte';
	import StepByStep from './StepByStep.svelte';
	import { answerFooterDelta, panelBodyShrink } from './xrayScroll';
	import RiScan2Line from '~icons/ri/scan-2-line';

	/**
	 * XRAY, as a composer panel (opened by the X-ray pill under the message box, or an answer's
	 * "How this was made"). Radiograph styling comes from the ComposerAccessory `xray` tone; the
	 * content is pinned to dark mode so its text tiers read on the film in either app mode.
	 *
	 * Three tabs: "This answer" (the plain-language receipt), "Step by step" (StepByStep — the layman's
	 * walk-through, including the second-opinion action) and "The stack" (the live layer map).
	 */
	let {
		messages = [],
		loading = false,
		conversationModelId
	}: { messages?: Message[]; loading?: boolean; conversationModelId: string } = $props();

	let tab = $state('answer');
	let panel: HTMLElement | undefined = $state();
	// The tab bodies' height once the panel has given some back to the answer (CUR-3951), read by
	// xray-body through --xray-body-max; unset, they keep xray-body's own height.
	let bodyMax: number | undefined = $state();

	// An answer's Second opinion action (CUR-4187): show Step by step and bring its offer into view.
	$effect(() => {
		if (!$xraySecondOpinion) return;
		xraySecondOpinion.set(false);
		tab = 'steps';
		void tick().then(() =>
			panel?.querySelector('[data-second-opinion-offer]')?.scrollIntoView({ block: 'nearest' })
		);
	});

	const answers = $derived(messages.filter((m) => m.from === 'assistant'));
	const answer = $derived(
		($xrayMessageId && answers.find((m) => m.id === $xrayMessageId)) || answers.at(-1)
	);
	const index = $derived(answer ? messages.indexOf(answer) : -1);
	const asked = $derived(
		index > 0 ? [...messages.slice(0, index)].reverse().find((m) => m.from === 'user') : undefined
	);
	const question = $derived(asked?.content);
	// More than the question itself came before this answer (a system prompt doesn't count).
	const followUp = $derived(
		index > 0 && messages.slice(0, index).filter((m) => m.from !== 'system').length > 1
	);
	const turnNumber = $derived(answer ? answers.indexOf(answer) + 1 : undefined);

	// The panel opens by easing its height up, taking that height from the thread, so the answer's footer
	// would slide under the panel's edge. While it opens, the thread scrolls to keep that footer, the line
	// X-ray is checked against, above the thread's bottom fade (CUR-3951). On a short window scrolling
	// stops at the answer's start (CUR-3934), so the tab bodies give back whatever height the footer is
	// still short of, down to MIN_BODY_PX.
	const OPENING_MS = 1000;
	const FOOTER_CLEARANCE_PX = 40;
	const MIN_BODY_PX = 128;
	onMount(() => {
		const thread = document.querySelector<HTMLElement>('[data-testid="chat-scroll"]');
		if (!thread || typeof ResizeObserver === 'undefined') return;
		const keepFooter = () => {
			const el = answer && thread.querySelector(`[data-message-id="${CSS.escape(answer.id)}"]`);
			if (!el) return;
			const view = thread.getBoundingClientRect();
			const box = el.getBoundingClientRect();
			const body = [...(panel?.querySelectorAll<HTMLElement>('.xray-body') ?? [])]
				.map((b) => b.offsetHeight)
				.find((h) => h > 0);
			const shrink = body ? panelBodyShrink(view, box, FOOTER_CLEARANCE_PX, body, MIN_BODY_PX) : 0;
			if (shrink && body) bodyMax = body - shrink;
			const delta = answerFooterDelta(view, box, FOOTER_CLEARANCE_PX);
			if (delta) thread.scrollBy({ top: delta });
		};
		// Watches the panel too: its tab bodies render after it starts opening, and the height they take
		// moves the footer without resizing the thread again. Stops once nothing has resized for
		// OPENING_MS, rather than a fixed time after mount, so late content is still caught.
		let stop: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(() => {
			keepFooter();
			clearTimeout(stop);
			stop = setTimeout(() => observer.disconnect(), OPENING_MS);
		});
		observer.observe(thread);
		if (panel) observer.observe(panel);
		return () => {
			clearTimeout(stop);
			observer.disconnect();
		};
	});
</script>

<div
	class="flex min-h-0 flex-col gap-3"
	style:--xray-body-max={bodyMax && `${bodyMax}px`}
	data-xray-panel
	bind:this={panel}
>
	<div class="flex items-baseline justify-between gap-3 pr-8 max-md:pr-0">
		<h2 class="flex items-center gap-2 type-title text-fg-1 max-md:hidden">
			<RiScan2Line aria-hidden="true" class="size-4 text-xray-glow" />
			{m.product_xray()}
			<span class="type-caption font-normal text-fg-3">
				{answer ? 'What happened behind the answer' : 'What Alpha is built from'}
			</span>
		</h2>
		{#if answer}
			<span class="type-caption text-fg-3">
				{turnNumber && answers.length > 1
					? `Answer ${turnNumber} of ${answers.length}`
					: 'Latest answer'}
			</span>
		{/if}
	</div>
	<!-- Nothing sent yet: there's no answer to describe, so X-ray is just the stack. -->
	{#if !answer}
		<div class="-mr-4 xray-body" data-xray-stack-only>
			<StackXRay {messages} active={loading} agentAvailable={page.data.agentEnabled} autoAvailable={page.data.autoRoutingEnabled} storageRegion={page.data.storageRegion} />
		</div>
	{:else}
		<!-- Every tab's body is the same height (the panel's maximum, matching the stack map's), so X-ray
	     opens at full height and never jumps as you switch tabs. On a short window that height shrinks,
	     so the answer stays in view above the panel (xray-body, CUR-3934). -->
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List>
				<Tabs.Tab value="answer">This answer</Tabs.Tab>
				<Tabs.Tab value="steps">Step by step</Tabs.Tab>
				<Tabs.Tab value="stack">The stack</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="answer" class="min-h-0 flex-1">
				<div
					class="-mr-4 scrollbar-custom flex xray-body scroll-fade-y flex-col gap-4 overflow-y-auto pt-4 pr-4"
				>
					<AnswerReceipt
						message={answer}
						{conversationModelId}
						signedIn={Boolean(page.data.user)}
						attachedFiles={asked?.files?.map((f) => f.name) ?? []}
					/>
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="steps" class="min-h-0 flex-1">
				<div
					class="-mr-4 scrollbar-custom flex xray-body scroll-fade-y flex-col overflow-y-auto pt-4 pr-4"
					data-xray-steps
				>
					<StepByStep
						message={answer}
						modelId={conversationModelId}
						{loading}
						{question}
						{followUp}
						safetyRules={page.data.safetyRules ?? []}
						attachedFiles={asked?.files?.map((f) => f.name) ?? []}
					/>
				</div>
			</Tabs.Panel>
			<div class="min-h-0 flex-1" class:hidden={tab !== 'stack'}>
				<div class="-mr-4 xray-body">
					<StackXRay {messages} active={loading} agentAvailable={page.data.agentEnabled} autoAvailable={page.data.autoRoutingEnabled} storageRegion={page.data.storageRegion} />
				</div>
			</div>
		</Tabs.Root>
	{/if}
</div>

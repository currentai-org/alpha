<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getContext } from 'svelte';
	import { BENTO_COMPACT, BentoTile, Tabs } from '@aipotluck/alpha-ds';
	import { BENTO_SIGNED_IN } from './context';
	import AnswerReceipt from '$lib/chat/components/stack/AnswerReceipt.svelte';
	import StepByStep from '$lib/chat/components/stack/StepByStep.svelte';
	import { demoAnswer } from '$lib/alpha-landing/demo-conversation';
	import RiScan2Line from '~icons/ri/scan-2-line';

	/**
	 * X-ray: the app's real X-ray content (AnswerReceipt + Step by step) on one of the demo answers,
	 * on the same radiograph film the composer panel uses — xray tokens, scan band. It follows the
	 * mode and theme of the page it sits on, like the composer panel does.
	 */
	const { answer } = demoAnswer();
	let tab = $state('answer');
	const signedInGetter = getContext<(() => boolean) | undefined>(BENTO_SIGNED_IN);
	const signedIn = $derived(signedInGetter?.() ?? false);

	// In a compact host (BENTO_COMPACT) every tile shares one height, set by the other bentos. There the
	// receipt fills whatever room the tile has and scrolls, rather than stretching every slide to fit it.
	const compact = getContext<boolean | undefined>(BENTO_COMPACT) ?? false;
	const scroller = $derived(
		compact
			? 'absolute inset-0 scrollbar-custom scroll-fade-y overflow-y-auto pt-4 pr-2'
			: 'scrollbar-custom max-h-96 scroll-fade-y overflow-y-auto pt-4 pr-2'
	);
</script>

<BentoTile
	icon={RiScan2Line}
	title={m.welcome_xrayTitle()}
	body={m.welcome_xrayBody()}
	sceneClass="items-stretch"
>
	<div
		class="xray-band relative flex w-full max-w-xl flex-col gap-3 rounded-card bg-surface-raised p-4 text-fg-1 xray-halo"
	>
		<p class="flex items-center gap-2 type-caption text-fg-2">
			<span class="flex shrink-0 items-center gap-2 whitespace-nowrap"><RiScan2Line aria-hidden="true" class="size-4 text-xray-glow" /> {m.welcome_xray()}</span>
			<span class="truncate text-fg-3">{m.welcome_xrayQuestion({ question: m.welcome_xraySampleQuestion() })}</span>
		</p>
		<Tabs.Root bind:value={tab} class="flex min-h-0 flex-1 flex-col">
			<Tabs.List>
				<Tabs.Tab value="answer">{m.welcome_thisAnswer()}</Tabs.Tab>
				<Tabs.Tab value="steps">{m.welcome_stepByStep()}</Tabs.Tab>
			</Tabs.List>
			<Tabs.Panel value="answer" class="relative min-h-0 flex-1">
				<div class={scroller}>
					<AnswerReceipt
						message={answer}
						conversationModelId={answer.routerMetadata?.model ?? ''}
						{signedIn}
					/>
				</div>
			</Tabs.Panel>
			<Tabs.Panel value="steps" class="relative min-h-0 flex-1">
				<div class={scroller}>
					<StepByStep message={answer} modelId={answer.routerMetadata?.model} />
				</div>
			</Tabs.Panel>
		</Tabs.Root>
	</div>
</BentoTile>

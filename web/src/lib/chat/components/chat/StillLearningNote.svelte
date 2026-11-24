<script lang="ts">
	import RiSeedlingLine from '~icons/ri/seedling-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import AnswerNote from './AnswerNote.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import { catalogByGatewayId } from '$lib/chat/routing/catalog';
	import { localClassifier } from '$lib/chat/routing/localClassifier';
	import { stillLearning, type LanguageGap } from '$lib/chat/routing/router';
	import { activeBenchmarks, activeRoutingConfig } from '$lib/chat/routing/state';

	/**
	 * The still-learning notice on a sent answer: the question was written in a language the
	 * model that answered is still learning. The composer's language pill says the same before sending;
	 * this keeps it beside the answer after sending and after a reload. Same test (`stillLearning`), same
	 * language detection as the composer (`localClassifier`), so the two never disagree about one turn.
	 */
	let { question, modelId }: { question: string; modelId: string } = $props();

	let gap = $state<LanguageGap | undefined>();
	$effect(() => {
		const text = question;
		const model = catalogByGatewayId(modelId);
		const opts = { benchmarks: $activeBenchmarks, config: $activeRoutingConfig };
		if (!model || !text.trim()) {
			gap = undefined;
			return;
		}
		let live = true;
		void localClassifier(text).then((analysis) => {
			if (live) gap = stillLearning(analysis, model.id, opts);
		});
		return () => {
			live = false;
		};
	});
</script>

{#if gap}
	<div data-still-learning={gap.tag}>
		<AnswerNote icon={RiSeedlingLine} tone="info" title={m.product_learningLanguage({ language: gap.name })}>
			<p>{m.chat_getInvolvedGap({ language: gap.name })}</p>
			<a
				href={`${base}/settings/contribute`}
				class="inline-flex items-center gap-1 self-start underline decoration-line-3 underline-offset-2 hover:text-fg-1"
			>
				{m.chat_otherWaysToHelp()} <RiArrowRightLine aria-hidden="true" class="size-3.5" />
			</a>
		</AnswerNote>
	</div>
{/if}

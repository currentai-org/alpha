<script lang="ts">
	import { Button } from '@aipotluck/alpha-ds';
	import { m } from '$lib/paraglide/messages.js';
	import { base } from '$lib/chat/paths';
	import type { LanguageGap, ModelScore } from '$lib/chat/routing/router';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import LanguageDataActions from '$lib/chat/components/language-data/LanguageDataActions.svelte';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';

	/**
	 * The language pill's panel: how well each model Alpha runs handles the language (one bar each,
	 * against the level where answers become dependable, with English for scale), then one section on
	 * how to help, a tile per way (LanguageDataActions' `tiles` layout, from languageData.ts). One measure, one
	 * neutral hue: the bars carry magnitude only, so they wear Text tokens; every value is printed
	 * beside its bar.
	 *
	 * Where the language was measured, the bars show each model's raw accuracy on the benchmark (the
	 * same number the models page shows) and the dependable line sits at the matching raw accuracy; a
	 * model nobody measured says so instead of showing a number. Where nothing was measured, the bars
	 * are the hand-set estimates and say that.
	 */
	let {
		gap,
		scores,
		weakSupport,
		reference,
		placeholder = false,
		embeddedDemo = false,
		onEmbeddedNavigate
	}: {
		gap: LanguageGap;
		/** Every catalog model's score for this message; the served ones are charted. */
		scores: ModelScore[];
		/** Support at which answers become dependable (the router's gap threshold, above chance). */
		weakSupport: number;
		/** A well-covered language for scale: its support and, when measured, its raw accuracy. */
		reference?: { name: string; value: number; raw?: number };
		placeholder?: boolean;
		/** The /alpha demo: the Contribute page is the full app's, so its link reports an intent. */
		embeddedDemo?: boolean;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	} = $props();

	const charted = $derived(
		scores
			.filter((s) => s.available)
			// Measured models first, best first; the unmeasured ones after them.
			.sort((a, b) => Number(!!b.measured) - Number(!!a.measured) || b.language - a.language)
			.slice(0, 4)
	);
	/** The benchmark behind the chart, when the language was measured. */
	const benchmark = $derived(charted.find((s) => s.measured)?.measured?.benchmark);
	const rows = $derived(
		charted.map((s) => ({
			label: s.model.name,
			value: benchmark ? (s.measured?.raw ?? null) : s.language
		}))
	);
	// On the raw scale, "dependable" is the same point above guessing as the router's threshold.
	const line = $derived(benchmark ? benchmark.chance + weakSupport * (1 - benchmark.chance) : weakSupport);
	const referenceValue = $derived(benchmark ? reference?.raw : reference?.value);
	const pct = (n: number) => `${Math.round(n * 100)}%`;
</script>

{#snippet more()}
	<Button
		href={`${base}/settings/contribute`}
		variant="link"
		size="sm"
		casing="sentence"
		class="shrink-0"
		data-language-gap-more
		onclick={(e) => {
			if (!embeddedDemo) return;
			e.preventDefault();
			onEmbeddedNavigate?.({ kind: 'app', label: m.chat_waysToContribute() });
		}}
	>
		{m.chat_otherWaysToHelp()} <RiArrowRightLine aria-hidden="true" />
	</Button>
{/snippet}

{#snippet track(value: number, fill: string)}
	<!-- One bar, with the dependable line drawn through it (the rows' segments line up into one rule). -->
	<span class="relative h-2 flex-1 bg-line-1 rounded-sharp">
		<span class="absolute inset-y-0 left-0 bar-width rounded-sharp {fill}" style:--bar-width={pct(value)}></span>
		<span
			class="absolute -inset-y-1 bar-offset border-l border-dashed border-fg-3"
			style:--bar-offset={pct(line)}
			aria-hidden="true"
		></span>
	</span>
{/snippet}

<div class="flex flex-col gap-4" data-language-gap-panel={gap.tag}>
	<!-- Only the heading clears the panel's close button; everything below runs full width. -->
	<div class="flex flex-col gap-1 pr-6">
		<h2 class="type-body text-fg-1">{m.chat_gapTitle({ language: gap.name })}</h2>
		<p class="type-caption text-fg-2">
			{m.chat_gapIntro({ language: gap.name })}
		</p>
	</div>

	<!-- Infographic: support per model, with the dependable line and a well-covered language for scale. -->
	<figure class="flex flex-col gap-2" aria-labelledby="gap-chart-caption">
		<figcaption id="gap-chart-caption" class="type-label text-fg-2">{m.chat_gapChartCaption({ language: gap.name })}</figcaption>
		<div class="flex flex-col gap-1.5">
			{#each rows as row (row.label)}
				{#if row.value === null}
					<div class="flex items-center gap-2" data-language-gap-unmeasured>
						<span class="w-30 shrink-0 truncate type-caption text-fg-1">{row.label}</span>
						<span class="flex-1 type-caption text-fg-3">{m.chat_gapNotMeasured({ language: gap.name })}</span>
					</div>
				{:else}
					<div class="flex items-center gap-2" title="{row.label}: {pct(row.value)}">
						<span class="w-30 shrink-0 truncate type-caption text-fg-1">{row.label}</span>
						{@render track(row.value, 'bg-fg-2')}
						<span class="w-11 shrink-0 text-right type-code text-fg-1 tabular-nums">{pct(row.value)}</span>
					</div>
				{/if}
			{/each}
			{#if reference && referenceValue !== undefined}
				<div class="flex items-center gap-2" title={m.chat_gapReferenceTitle({ language: reference.name, value: pct(referenceValue) })}>
					<span class="w-30 shrink-0 truncate type-caption text-fg-3">{m.chat_gapReferenceLabel({ language: reference.name })}</span>
					{@render track(referenceValue, 'bg-line-3')}
					<span class="w-11 shrink-0 text-right type-code text-fg-3 tabular-nums">{pct(referenceValue)}</span>
				</div>
			{/if}
		</div>
		<p class="flex items-center gap-2 type-caption text-fg-3" data-language-gap-source>
			<span class="h-3 border-l border-dashed border-fg-3" aria-hidden="true"></span>
			{#if benchmark}
				{m.chat_gapBenchmarkSource({
					threshold: pct(line),
					benchmark: benchmark.name,
					ran: benchmark.ran,
					questions: benchmark.questions,
					chance: pct(benchmark.chance)
				})}
			{:else}
				{placeholder
					? m.chat_gapEstimateSourcePlaceholder({ threshold: pct(weakSupport) })
					: m.chat_gapEstimateSource({ threshold: pct(weakSupport) })}
			{/if}
		</p>
		{#if benchmark}
			<p class="type-caption text-fg-3" data-language-gap-measures>
				{benchmark.measures}
				{benchmark.doesNotMeasure}
			</p>
		{/if}
	</figure>

	<!-- What someone can do about it: one titled section, one tile per way to help. -->
	<section class="flex flex-col gap-2.5 border-t border-line-1 pt-4" aria-labelledby="gap-help-heading" data-language-gap-help>
		<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
			<h3 id="gap-help-heading" class="type-body text-fg-1">{m.languageData_helpHeading({ language: gap.name })}</h3>
			{@render more()}
		</div>
		{#if !embeddedDemo}
			<LanguageDataActions language={gap.tag} name={gap.name} surface="composer_language_panel" layout="tiles" />
		{/if}
	</section>
</div>

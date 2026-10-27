<script lang="ts">
	import { Badge, Meter } from '@aipotluck/alpha-ds';
	import { languageName } from '$lib/chat/routing/languages';
	import { SKILL_LABEL, type DraftAnalysis, type SkillId } from '$lib/chat/routing/classifier';
	import type { RouteChoice } from '$lib/chat/routing/router';
	import RiGlobalLine from '~icons/ri/global-line';
	import RiCodeSSlashLine from '~icons/ri/code-s-slash-line';
	import RiCalculatorLine from '~icons/ri/calculator-line';
	import RiTranslate2 from '~icons/ri/translate-2';
	import RiSearchLine from '~icons/ri/search-line';
	import RiBrainLine from '~icons/ri/brain-line';
	import type { Component } from 'svelte';
	import { m } from '$lib/paraglide/messages.js';

	/**
	 * Why Auto picked the model it did, for the composer's model picker: what was detected (language
	 * or dialect, task size, skills the answer will want), the plain-language reason, and where the
	 * chosen model sits on the two benchmark axes against what the task needs.
	 */
	let {
		analysis,
		choice,
		pending = false,
		refining = false,
		placeholder = false
	}: {
		analysis: DraftAnalysis;
		choice: RouteChoice;
		/** A fresher analysis is on its way (the person is still typing). */
		pending?: boolean;
		/** A hosted classifier is reading the draft. */
		refining?: boolean;
		/** The benchmark table is placeholder data. */
		placeholder?: boolean;
	} = $props();

	const SKILL_ICON: Record<SkillId, Component> = {
		'web-search': RiGlobalLine,
		code: RiCodeSSlashLine,
		math: RiCalculatorLine,
		translation: RiTranslate2,
		research: RiSearchLine,
		reasoning: RiBrainLine
	};

	const picked = $derived(choice.scores.find((s) => s.model.id === choice.model.id));
	const lang = $derived(analysis.language.value);
	const sureness = (c: number) =>
		c >= 0.75 ? m.message_routeConfident() : c >= 0.5 ? m.message_routeFairlySure() : m.message_routeBestGuess();
	const pct = (n: number) => `${Math.round(n * 100)}%`;
	// Where the read came from, in the footer: the device, or the hosted classifier that read it.
	const readBy = $derived(
		analysis.source === 'remote'
			? m.message_routeReadBy({ classifier: analysis.classifier === 'clef-flash' ? 'Clef Flash' : 'Clef' })
			: refining
				? m.message_routeOnDeviceRefining()
				: m.message_routeOnDevice()
	);
</script>

<div class="flex flex-col gap-2.5" class:opacity-70={pending} data-routing-why aria-busy={pending}>
	{#if analysis.skills.length}
		<!-- Language and task size are in the picker's preview line above; skills are what's new here. -->
		<div class="flex flex-wrap items-center gap-1.5" data-routing-detected>
			{#each analysis.skills as skill (skill.id)}
				{@const Icon = SKILL_ICON[skill.id]}
				<Badge tone="outline" title={skill.reason} data-routing-skill={skill.id}>
					<Icon aria-hidden="true" />
					{SKILL_LABEL[skill.id]}
				</Badge>
			{/each}
		</div>
	{/if}

	<p class="type-caption text-fg-2" aria-live="polite">{choice.explanation}</p>

	{#if picked}
		<div class="grid grid-cols-1 gap-2" aria-label={m.message_routeFits({ model: choice.model.family })}>
			{#if lang !== 'und'}
				<Meter.Root value={picked.language} max={1} format={pct}>
					<Meter.Label>{m.message_routeLanguageSupport({ language: languageName(lang) })}</Meter.Label>
					<Meter.Value />
					<Meter.Track><Meter.Indicator /></Meter.Track>
				</Meter.Root>
			{/if}
			<Meter.Root
				value={picked.intelligence}
				max={Math.max(...choice.scores.map((s) => s.intelligence))}
				format={(v) => m.message_routeIntelligenceValue({ score: Math.round(v), target: choice.target })}
			>
				<Meter.Label>{m.message_routeIntelligence()}</Meter.Label>
				<Meter.Value />
				<Meter.Track><Meter.Indicator /></Meter.Track>
			</Meter.Root>
		</div>
	{/if}

	<p class="type-caption text-fg-3">
		{sureness(Math.min(analysis.language.confidence || 1, analysis.difficulty.confidence))} · {readBy}{placeholder
			? ` · ${m.message_routeEarlyEstimates()}`
			: ''}
	</p>
</div>

<script lang="ts">
	import type { Component } from 'svelte';
	import { Kbd, Radio, RadioGroup } from '@aipotluck/alpha-ds';
	import { CANT_TELL, type EvalQuestion } from '$lib/chat/evaluate/types';
	import ScaleGlyph from './ScaleGlyph.svelte';
	import RiCheckDoubleLine from '~icons/ri/check-double-line';
	import RiEditLine from '~icons/ri/edit-line';
	import RiCloseLine from '~icons/ri/close-line';
	import RiShieldCheckLine from '~icons/ri/shield-check-line';
	import RiErrorWarningLine from '~icons/ri/error-warning-line';
	import RiAlarmWarningLine from '~icons/ri/alarm-warning-line';
	import RiChatCheckLine from '~icons/ri/chat-check-line';
	import RiHand from '~icons/ri/hand';
	import RiForbidLine from '~icons/ri/forbid-line';
	import RiQuestionLine from '~icons/ri/question-line';

	/**
	 * One question's answers as large tiles, every label visible and none selected to start. A
	 * scale point carries its number and a rising-bars glyph; a choice carries an icon for its
	 * meaning. Each tile shows the number key that picks it (the page listens for those keys).
	 */
	let {
		question,
		value = $bindable(''),
		disabled = false,
		onpick
	}: {
		question: EvalQuestion;
		value?: string;
		disabled?: boolean;
		/** After a pick by click or tap; the page moves on to the next question. */
		onpick?: (value: string) => void;
	} = $props();

	const ICONS: Record<string, Component> = {
		as_is: RiCheckDoubleLine,
		small_edits: RiEditLine,
		no: RiCloseLine,
		safe: RiShieldCheckLine,
		some_risk: RiErrorWarningLine,
		harmful: RiAlarmWarningLine,
		over_cautious: RiHand,
		refused: RiForbidLine,
		[CANT_TELL]: RiQuestionLine
	};
	// `refusal: no` means it answered as it should, not "no, I wouldn't use it".
	const iconFor = (v: string) => (question.key === 'refusal' && v === 'no' ? RiChatCheckLine : ICONS[v]);

	const options = $derived([
		...question.options.map((o) => ({ value: String(o.value), label: o.label, scale: question.type === 'scale' ? Number(o.value) : 0 })),
		...(question.allowCantTell ? [{ value: CANT_TELL, label: question.cantTellLabel ?? 'I can’t tell', scale: 0 }] : [])
	]);
</script>

<RadioGroup
	bind:value
	aria-label={question.label}
	aria-required={question.required}
	{disabled}
	class="flex flex-col gap-1.5"
	data-eval-options={question.key}
>
	{#each options as option, i (option.value)}
		{@const Icon = iconFor(option.value)}
		<!-- The click only moves on after a pick; the radio inside is what's interactive, and the
		     keyboard has its own route (arrows or 1–9 to pick, Enter to move on). -->
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
		<label
			class="relative flex min-h-12 cursor-pointer items-center gap-3 border border-line-2 bg-surface-raised px-3 py-2.5 rounded-card transition-control hover:tint-hover has-focus-visible:outline-2 has-focus-visible:outline-fg-1 has-data-checked:border-fg-1 has-data-checked:tint-active"
			data-eval-option={option.value}
			onclick={(e) => {
				// The label forwards its click to the radio, which bubbles back here: act on the
				// person's click only. Space and arrow keys select without moving on.
				if (disabled || (e.target as HTMLElement).closest('[role="radio"]')) return;
				queueMicrotask(() => onpick?.(option.value));
			}}
		>
			<Radio.Root value={option.value} class="sr-only" />
			<span class="flex w-6 shrink-0 justify-center text-fg-2">
				{#if option.scale}<ScaleGlyph value={option.scale} />{:else if Icon}<Icon aria-hidden="true" class="size-4" />{/if}
			</span>
			<span class="min-w-0 flex-1 type-body text-fg-1">{option.label}</span>
			<Kbd class="max-sm:hidden">{i + 1}</Kbd>
		</label>
	{/each}
</RadioGroup>

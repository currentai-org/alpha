<script lang="ts">
	import type { Component, Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import RiArrowDownSLine from '~icons/ri/arrow-down-s-line';

	/**
	 * One shape for every note Alpha attaches to an answer — unverified links, a corrected name, a
	 * safety heads-up, a saved offline answer, a locked capability, a non-answer. Built for people who
	 * don't know the system: a short plain title with an icon, an optional action, and "What's this?"
	 * which opens the explanation inline (works on touch, unlike a hover tooltip).
	 *
	 * Tone: `caution` (amber) when Alpha corrected or flagged something — the system WORKED, so never
	 * red; `info` (neutral) when it's just context. Red is reserved for real stops and errors.
	 */
	let {
		icon: Glyph,
		title,
		tone = 'caution',
		flash = false,
		action,
		children
	}: {
		icon: Component<Record<string, unknown>>;
		title: string;
		tone?: 'caution' | 'info';
		/** Briefly highlight (e.g. when a marker in the answer points here). */
		flash?: boolean;
		action?: Snippet;
		/** The explanation, shown under "What's this?". */
		children?: Snippet;
	} = $props();

	let open = $state(false);
	const id = $props.id();
</script>

<div
	class="mt-1 flex flex-col gap-1.5 py-1.5 transition-control rounded-card {flash
		? '-mx-2 bg-caution/10 px-2 ring-1 ring-caution/40'
		: ''}"
	data-answer-note
>
	<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
		<Glyph aria-hidden="true" class="size-4 shrink-0 {tone === 'caution' ? 'text-caution-text' : 'text-fg-3'}" />
		<span class="type-caption text-fg-2">{title}</span>
		{@render action?.()}
		{#if children}
			<button
				type="button"
				class="inline-flex items-center gap-0.5 type-caption text-fg-3 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
				aria-expanded={open}
				aria-controls="{id}-why"
				onclick={() => (open = !open)}
			>
				What’s this?
				<RiArrowDownSLine aria-hidden="true" class="size-3.5 transition-transform {open ? 'rotate-180' : ''}" />
			</button>
		{/if}
	</div>
	{#if open && children}
		<div id="{id}-why" class="flex flex-col gap-1.5 type-caption text-fg-2" transition:slide={{ duration: 140 }}>
			{@render children()}
		</div>
	{/if}
</div>

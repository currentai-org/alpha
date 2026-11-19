<script lang="ts">
	import type { Snippet } from 'svelte';
	import { VisuallyHidden } from '@aipotluck/alpha-ds';
	import RiInformationLine from '~icons/ri/information-line';
	import { BELEBELE_FULL_SET, percent, type LeaderboardCell } from '$lib/chat/routing/leaderboard';

	/**
	 * One row of the language leaderboard: the name on the left, the score as a bar on the right, and
	 * the evidence (range, questions, date, run) one tap away. The bar fills to the score, the short
	 * line across its end is the 95% range and the thin line is guessing. A score too small to compare is drawn
	 * faint and says so in words, so the status never rests on colour alone.
	 */
	let {
		cell,
		chance,
		name,
		formatDate
	}: {
		cell: LeaderboardCell;
		/** The guessing floor, 0–1, drawn as a line on the bar. */
		chance: number;
		/** The row's name: the model in the language view, the language in the model view. */
		name: Snippet;
		formatDate: (iso: string) => string;
	} = $props();

	let open = $state(false);
	const pct = (p: number) => `${p * 100}%`;
	const measured = $derived(cell.status !== 'not-measured');
	const detailsId = $derived(`details-${cell.model.id}-${cell.language}`);
</script>

<li class="flex flex-col gap-2 border-b border-line-1 py-3" data-leaderboard-row={cell.model.id} data-language={cell.language} data-status={cell.status}>
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
		<div class="flex min-w-0 flex-col gap-0.5 sm:w-2/5 sm:shrink-0">
			{@render name()}
			{#if cell.status === 'too-few'}
				<span class="type-caption text-caution-text">Too few questions to compare</span>
			{/if}
		</div>

		<div class="flex min-w-0 flex-1 items-center gap-3">
			{#if measured}
				<div class="relative h-3 flex-1 rounded-pill bg-surface-3" aria-hidden="true">
					<span
						class="absolute inset-y-0 left-0 bar-width rounded-pill bg-accent-1 {cell.status === 'compared' ? '' : 'opacity-40'}"
						style:--bar-width={pct(cell.accuracy!)}
					></span>
					<span
						class="absolute top-1/2 h-0.5 -translate-y-1/2 bar-offset bar-width bg-fg-1"
						style:--bar-offset={pct(cell.low!)}
						style:--bar-width={pct(cell.high! - cell.low!)}
					></span>
					<span class="absolute -inset-y-1 w-px bar-offset bg-line-strong" style:--bar-offset={pct(chance)}></span>
				</div>
				<span class="w-12 shrink-0 text-right type-body text-fg-1 tabular-nums" data-leaderboard-score>
					{percent(cell.accuracy!)}<VisuallyHidden>, likely between {percent(cell.low!)} and {percent(cell.high!)}</VisuallyHidden>
				</span>
				<button
					type="button"
					class="shrink-0 rounded-sharp p-1 text-fg-3 hover:text-fg-1"
					aria-expanded={open}
					aria-controls={detailsId}
					aria-label="Details"
					onclick={() => (open = !open)}
					data-leaderboard-details-toggle
				>
					<RiInformationLine aria-hidden="true" class="size-4" />
				</button>
			{:else}
				<span class="flex-1 text-right type-body text-fg-2" data-leaderboard-score>Not measured yet</span>
				<span class="w-6 shrink-0" aria-hidden="true"></span>
			{/if}
		</div>
	</div>

	{#if measured && open}
		<div id={detailsId} class="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-fg-2" data-leaderboard-details>
			<span>Likely {percent(cell.low!)} to {percent(cell.high!)}</span>
			<span>{cell.questions} of {BELEBELE_FULL_SET} questions{cell.partial ? ' (partial run)' : ''}</span>
			<span>{formatDate(cell.benchmark!.ran)}</span>
			<a
				href={cell.benchmark!.url}
				target="_blank"
				rel="noreferrer"
				class="text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1"
				title={cell.benchmark!.version}>{cell.benchmark!.name}</a
			>
		</div>
	{/if}
</li>

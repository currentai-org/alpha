<script lang="ts">
	import { Meter } from '@aipotluck/alpha-ds';
	import type { EvalApi } from '$lib/chat/evaluate/client';
	import type { LanguageResults, ModelResult } from '$lib/chat/evaluate/types';

	/**
	 * How each model does in a language so far, from people's ratings (`GET /results`, aggregate.ts).
	 * A model below the thresholds shows its counts, never a share or a mean; one nobody has rated says
	 * so rather than showing a zero. Models are listed by name, never ranked.
	 */
	let { api, language, label }: { api: EvalApi; language: string; label: string } = $props();

	let results = $state<LanguageResults | null>(null);
	let failed = $state(false);

	$effect(() => {
		const id = language;
		let live = true;
		results = null;
		failed = false;
		api.results(id).then(
			(r) => live && (results = r),
			() => live && (failed = true)
		);
		return () => {
			live = false;
		};
	});

	const percent = (v: number) => `${Math.round(v * 100)}%`;
	const mean = (v: number | null) => (v === null ? '–' : v.toFixed(1));
	const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;
	const ratings = (n: number) => `${n} ${n === 1 ? 'rating' : 'ratings'}`;

	function means(m: ModelResult) {
		if (!m.means) return [];
		return [
			{ label: 'Does what was asked', value: m.means.task },
			{ label: 'Correct', value: m.means.accuracy },
			{ label: `Natural ${label}`, value: m.means.language }
		];
	}
</script>

{#if failed}
	<p class="type-caption text-fg-3" data-eval-results-error>Results for {label} couldn’t load.</p>
{:else if results?.kind === 'results'}
	{@const t = results.thresholds}
	<section class="flex flex-col gap-3" aria-labelledby="eval-results-label" data-eval-results>
		<div class="flex flex-col gap-1">
			<h3 id="eval-results-label" class="type-title text-fg-1">How models do in {label} so far</h3>
			<p class="type-caption text-fg-2">
				From ratings by native and fluent speakers. A model gets a result once it has {t.minRatings} ratings from {t.minRaters}
				people across {t.minTasks} requests.
			</p>
		</div>
		{#if results.models.length}
			<ul class="flex flex-col divide-y divide-line-2 border border-line-2 rounded-card">
				{#each results.models as m (m.modelId)}
					<li class="flex flex-col gap-2 px-3 py-3" data-eval-result={m.status}>
						<span class="type-body font-medium text-fg-1">{m.name}</span>
						{#if m.status === 'shown' && m.usable}
							<Meter.Root value={m.usable.share} max={1} format={percent} class="max-w-sm">
								<Meter.Label>Would use the answer</Meter.Label>
								<Meter.Value />
								<Meter.Track><Meter.Indicator tone="accent" /></Meter.Track>
							</Meter.Root>
							<p class="type-caption text-fg-2">
								Likely between {percent(m.usable.low)} and {percent(m.usable.high)} · {ratings(m.nRatings)} from {people(m.nRaters)}
							</p>
							<dl class="flex flex-wrap gap-x-4 gap-y-1 type-caption">
								{#each means(m) as q (q.label)}
									<div class="flex gap-1">
										<dt class="text-fg-2">{q.label}</dt>
										<dd class="text-fg-1 tabular-nums">{mean(q.value)} / 5</dd>
									</div>
								{/each}
							</dl>
						{:else if m.status === 'insufficient'}
							<p class="type-caption text-fg-2">
								Not enough ratings yet: {m.nRatings} of {t.minRatings}, from {people(m.nRaters)}.
							</p>
						{:else}
							<p class="type-caption text-fg-2">Nobody has rated it yet.</p>
						{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="type-caption text-fg-2" data-eval-results-empty>
				There are no answers to rate in {label} yet, so there are no results either.
			</p>
		{/if}
	</section>
{/if}

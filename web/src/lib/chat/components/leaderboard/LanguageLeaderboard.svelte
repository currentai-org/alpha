<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Button, Collapsible, Combobox, Field, PageHeader, Surface, Tabs, ThemeProvider, fuzzyFilter } from '@aipotluck/alpha-ds';
	import { base, chatHome } from '$lib/chat/paths';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import RiArrowRightSLine from '~icons/ri/arrow-right-s-line';
	import OrgMention from '$lib/chat/components/provenance/OrgMention.svelte';
	import { orgs } from '$lib/chat/routing/catalog';
	import { LAUNCH_LANGUAGES } from '$lib/chat/languageData';
	import { languageName } from '$lib/chat/routing/languages';
	import { languagePickerItems, ownLanguageName } from '$lib/chat/routing/leaderboard';
	import { langAttr } from '$lib/chat/evaluate/endonym';
	import { SHIPPED_LANGUAGE_SCORES } from '$lib/chat/routing/languageScores';
	import { wwwPickerCatalog } from '$lib/chat/routing/wwwPicker';
	import {
		BELEBELE_FULL_SET,
		MIN_QUESTIONS_TO_COMPARE,
		languageBoard,
		latestRun,
		modelBoard
	} from '$lib/chat/routing/leaderboard';
	import ScoreRow from './ScoreRow.svelte';

	/**
	 * The public language leaderboard: how the models Alpha serves score on Belebele, by
	 * language or by model, with the evidence behind each score. Every number is read from the app's
	 * language scores through routing/leaderboard.ts; nothing here is typed by hand. The view, language
	 * and model live in the URL, so a link opens on what its sender was looking at.
	 */
	let { openingLanguage }: { openingLanguage: string } = $props();

	const data = SHIPPED_LANGUAGE_SCORES;
	const models = wwwPickerCatalog;
	const languages: string[] = [...LAUNCH_LANGUAGES].sort((a, b) => languageName(a).localeCompare(languageName(b)));

	const params = $derived(page.url.searchParams);
	const view = $derived(params.get('view') === 'model' ? 'model' : 'language');
	const language = $derived.by(() => {
		const tag = params.get('language');
		return tag && languages.includes(tag) ? tag : openingLanguage;
	});
	const languageCells = $derived(languageBoard(data, models, language));
	const modelId = $derived.by(() => {
		const id = params.get('model');
		if (id && models.some((m) => m.id === id)) return id;
		return languageCells.find((c) => c.status !== 'not-measured')?.model.id ?? models[0].id;
	});
	const model = $derived(models.find((m) => m.id === modelId)!);
	const modelCells = $derived(modelBoard(data, model, languages, languageName));

	const cells = $derived(view === 'language' ? languageCells : modelCells);
	const missing = $derived(cells.filter((c) => c.status === 'not-measured').length);
	const closeCount = $derived(languageCells.filter((c) => c.closeToTop).length);

	// The guessing floor and the plain-words description come from the data. A full-set entry carries
	// the general wording; a partial one adds a sentence about its own run.
	const reference = Object.values(data.benchmarks).find((b) => b.questions >= BELEBELE_FULL_SET) ?? Object.values(data.benchmarks)[0];
	const wevalUrl = Object.values(data.benchmarks).find((b) => new URL(b.url).hostname.endsWith('weval.org'))?.url;
	const chance = reference?.chance ?? 0.25;
	const latest = latestRun(data, models, languages);

	const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
	const formatDate = (iso: string) => dateFormat.format(new Date(`${iso}T00:00:00Z`));

	function show(next: { view?: string; language?: string; model?: string }) {
		const q = [
			['view', next.view ?? view],
			['language', next.language ?? language],
			['model', next.model ?? modelId]
		]
			.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
			.join('&');
		void goto(`?${q}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	const contributeHref = $derived(
		`${base}/settings/contribute${view === 'language' && language !== 'eng' ? `?language=${language}` : ''}`
	);
	const otherLanguageHref = $derived(`${base}/settings/contribute`);
	// Searchable by the English name, the language's own name and its code, with typos and accents,
	// the same fuzzy matching as the Contribute page's language picker.
	const languageItems = languagePickerItems(languages);
	const modelItems = models.map((m) => ({ value: m.id, label: m.name, keywords: [m.family, orgs[m.maker].name, m.id] }));
	let languageQuery = $state('');
	let modelQuery = $state('');
	const languageMatches = $derived(fuzzyFilter(languageItems, languageQuery));
	const modelMatches = $derived(fuzzyFilter(modelItems, modelQuery));
	let methodOpen = $state(false);
</script>

<ThemeProvider mode="system" theme="alpha">
	<Surface level="1" class="min-h-dvh">
		<main class="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 pt-12 pb-24 md:pt-16" data-language-leaderboard>
			<PageHeader
				eyebrow="Alpha · Languages"
				title="How Alpha’s models read your language"
				description={`Scores on Belebele, a reading test, for each model you can pick in Alpha, in the ${languages.length} languages we test.`}
			>
				{#snippet actions()}
					<div class="flex flex-wrap gap-2" data-leaderboard-actions>
						<Button href={contributeHref} variant="primary" size="sm" casing="sentence" data-leaderboard-contribute-link>
							Help improve {view === 'language' ? languageName(language) : 'your language'}
						</Button>
						<Button href={chatHome} variant="secondary" size="sm" casing="sentence">
							Try Alpha <RiArrowRightLine aria-hidden="true" />
						</Button>
					</div>
				{/snippet}
			</PageHeader>

			<p class="type-caption text-fg-2" data-leaderboard-early>
				Early results. Most runs used part of Belebele’s 900 questions per language, and not all models got the same questions,
				so small differences don’t tell you which model is better.
			</p>

			<section class="flex flex-col gap-4" aria-label="Scores">
				<Tabs.Root value={view} onValueChange={(v: string) => show({ view: v })} variant="segment" class="gap-4">
					<Tabs.List aria-label="Compare">
						<Tabs.Tab value="language">By language</Tabs.Tab>
						<Tabs.Tab value="model">By model</Tabs.Tab>
					</Tabs.List>
				</Tabs.Root>

				{#if view === 'language'}
					<Field.Root class="max-w-xs">
						<Field.Label>Language</Field.Label>
						<Combobox.Root
							value={language}
							items={languageItems}
							inputValue={languageItems.find((o) => o.value === language)?.label ?? ''}
							onValueChange={(v: string) => v && show({ language: v })}
							onOpenChange={(open: boolean) => {
								if (!open) languageQuery = '';
							}}
						>
							<Combobox.Input
								data-leaderboard-language-select
								placeholder="Search a language"
								triggerLabel="Show languages"
								oninput={(e: Event & { currentTarget: HTMLInputElement }) => (languageQuery = e.currentTarget.value)}
							/>
							<Combobox.Portal>
								<Combobox.Positioner>
									<Combobox.Popup>
										{#each languageMatches as option (option.value)}
											<Combobox.Item value={option.value} label={option.label} />
										{:else}
											<Combobox.Empty>No match</Combobox.Empty>
										{/each}
									</Combobox.Popup>
								</Combobox.Positioner>
							</Combobox.Portal>
						</Combobox.Root>
					</Field.Root>
					{#if closeCount > 1}
						<p class="type-caption text-fg-2" data-leaderboard-close-note>
							The top {closeCount} scores in {languageName(language)} are too close to call: their likely ranges overlap.
						</p>
					{/if}
				{:else}
					<Field.Root class="max-w-xs">
						<Field.Label>Model</Field.Label>
						<Combobox.Root
							value={modelId}
							items={modelItems}
							inputValue={modelItems.find((o) => o.value === modelId)?.label ?? ''}
							onValueChange={(v: string) => v && show({ model: v })}
							onOpenChange={(open: boolean) => {
								if (!open) modelQuery = '';
							}}
						>
							<Combobox.Input
								data-leaderboard-model-select
								placeholder="Search a model"
								triggerLabel="Show models"
								oninput={(e: Event & { currentTarget: HTMLInputElement }) => (modelQuery = e.currentTarget.value)}
							/>
							<Combobox.Portal>
								<Combobox.Positioner>
									<Combobox.Popup>
										{#each modelMatches as option (option.value)}
											<Combobox.Item value={option.value} label={option.label} />
										{:else}
											<Combobox.Empty>No match</Combobox.Empty>
										{/each}
									</Combobox.Popup>
								</Combobox.Positioner>
							</Combobox.Portal>
						</Combobox.Root>
					</Field.Root>
					<p class="flex flex-wrap items-center gap-x-1.5 type-caption text-fg-2">
						Made by <OrgMention org={orgs[model.maker]} />
					</p>
				{/if}

				<p class="type-caption text-fg-3" aria-hidden="true" data-leaderboard-legend>
					Bar: % of correct answers. Short line: likely range. Thin line: guessing ({Math.round(chance * 100)}%). Tap ⓘ for details.
				</p>
				<ul class="flex flex-col border-t border-line-1" aria-live="polite" data-leaderboard-list={view}>
					{#each cells as cell (`${cell.model.id}:${cell.language}`)}
						<ScoreRow {cell} {chance} {formatDate}>
							{#snippet name()}
								{#if view === 'language'}
									<button
										type="button"
										class="self-start text-left type-body text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
										onclick={() => show({ view: 'model', model: cell.model.id })}
									>
										{cell.model.name}
									</button>
									<span class="type-caption text-fg-3"><OrgMention org={orgs[cell.model.maker]} /></span>
								{:else}
									<button
										type="button"
										class="self-start text-left type-body text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
										onclick={() => show({ view: 'language', language: cell.language })}
									>
										{languageName(cell.language)}
									</button>
									{#if ownLanguageName(cell.language)}
										<span class="type-caption text-fg-3" lang={langAttr(cell.language)}>{ownLanguageName(cell.language)}</span>
									{/if}
								{/if}
							{/snippet}
						</ScoreRow>
					{/each}
				</ul>

				<p class="type-caption text-fg-2" data-leaderboard-contribute>
					{#if view === 'language'}
						{missing
							? `${missing} of ${models.length} models are not measured yet in ${languageName(language)}.`
							: `Every model has a score in ${languageName(language)}.`}
					{:else}
						{missing ? `${model.name} is not measured yet in ${missing} of ${languages.length} languages.` : `${model.name} has a score in every language we test.`}
					{/if}
					People who speak a language can help by sharing data, recording sentences or telling us about a model that handles it well.
					<a class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1" href={contributeHref}>Help improve {view === 'language' ? languageName(language) : 'your language'}</a>.
				</p>
				<p class="type-caption text-fg-2" data-leaderboard-other-language>
					Don’t see your language? We test {languages.length} languages today.
					<a class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1" href={otherLanguageHref}>Tell us which one you need</a>.
				</p>
			</section>


			<div class="border-t border-line-1 pt-4">
			<Collapsible.Root bind:open={methodOpen} class="flex flex-col gap-3">
				<Collapsible.Trigger>
					<RiArrowRightSLine aria-hidden="true" class={methodOpen ? 'rotate-90' : ''} /> How to read the scores
				</Collapsible.Trigger>
				<Collapsible.Panel>
					<div class="flex flex-col gap-3 type-body text-fg-2" data-leaderboard-method>
						<ul class="flex list-disc flex-col gap-2 pl-5" data-leaderboard-explainer>
							<li>{reference?.measures}</li>
							<li>{reference?.doesNotMeasure} A higher score does not mean a better conversation.</li>
							<li>Each question has four possible answers, so guessing gets {Math.round(chance * 100)}% right.</li>
							<li>
								The likely range is where the score would probably fall if the model were tested on other questions. Fewer
								questions give a wider range. When two ranges overlap, we can’t say which model is better, so we don’t number
								the rows.
							</li>
							<li>A score from fewer than {MIN_QUESTIONS_TO_COMPARE} questions is shown but not compared with the others.</li>
							<li>“Not measured yet” means nobody has run the test for that model and language. It is not a score of zero.</li>
						</ul>
						<p>
							Each score is one run. When a model was tested more than once in a language, we show the latest run and never
							average runs.
						</p>
						<p>
							The ranges are 95% Wilson intervals on the share of questions answered correctly. They cover the luck of which
							questions were asked. They don’t cover differences between runs, such as which questions were used, how the
							model was reached or which prompt it was given.
						</p>
						<p>
							Alpha’s automatic model choice sometimes uses a score measured on a closely related model until a model is
							tested itself. This page shows only scores measured on the model itself.
						</p>
						<p>
							Belebele was published by Bandarkar and colleagues in 2023:
							<a
								class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
								href="https://arxiv.org/abs/2308.16884"
								target="_blank"
								rel="noreferrer">the paper</a
							>
							and
							<a
								class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
								href="https://huggingface.co/datasets/facebook/belebele"
								target="_blank"
								rel="noreferrer">the dataset</a
							>.
						</p>
						{#if wevalUrl}
							<p class="flex flex-wrap items-center gap-x-1.5">
								Runs on
								<a
									class="text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
									href={wevalUrl}
									target="_blank"
									rel="noreferrer">weval</a
								>
								were done by <OrgMention org={orgs.cip} />, the others by Current AI. Each score links to the run it comes from.
							</p>
						{/if}
					</div>
				</Collapsible.Panel>
			</Collapsible.Root>
			</div>

			{#if latest}
				<p class="type-caption text-fg-3" data-leaderboard-latest>Latest run behind these scores: {formatDate(latest)}.</p>
			{/if}
		</main>
	</Surface>
</ThemeProvider>

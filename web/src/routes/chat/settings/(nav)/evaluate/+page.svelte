<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsSubpage, settingsWidePage } from '$lib/chat/settingsSections';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { base } from '$lib/chat/paths';
	import { trackEvent } from '$lib/analytics';
	import { Badge, Button, Checkbox, Radio, RadioGroup, Select, Spinner, ToggleGroup, Toggle } from '@aipotluck/alpha-ds';
	import { EvalApiError, httpEvalApi, type EvalApi } from '$lib/chat/evaluate/client';
	import { RUBRIC_CREDIT, sampleEvalApi, type SampleScenario } from '$lib/chat/evaluate/fixtures';
	import { LEVELS, rememberProfile, rememberedProfile } from '$lib/chat/evaluate/profile';
	import { EXCLUDING_FLAGS, missingQuestions, toScores } from '$lib/chat/evaluate/rating';
	import { endonym, langAttr } from '$lib/chat/evaluate/endonym';
	import { evalLanguageId, evaluationLanguages } from '$lib/chat/evaluate/languages';
	import {
		CANT_TELL,
		DAILY_RATING_CAP,
		type Consent,
		type DeclaredLevel,
		type EvalLanguage,
		type EvalQuestion,
		type NextItem
	} from '$lib/chat/evaluate/types';
	import EvalExchange from '$lib/chat/components/evaluate/EvalExchange.svelte';
	import QuestionStepper from '$lib/chat/components/evaluate/QuestionStepper.svelte';
	import RubricCredit from '$lib/chat/components/evaluate/RubricCredit.svelte';
	import EvalResults from '$lib/chat/components/evaluate/EvalResults.svelte';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';
	import RiChatQuoteLine from '~icons/ri/chat-quote-line';
	import RiCheckboxMultipleLine from '~icons/ri/checkbox-multiple-line';
	import RiBarChart2Line from '~icons/ri/bar-chart-2-line';
	import RiCheckboxCircleLine from '~icons/ri/checkbox-circle-line';
	import RiCheckLine from '~icons/ri/check-line';
	import type { PageData } from './$types';

	/**
	 * Human evaluation, a settings page so the nav stays beside it, built like a short game rather than a form: pick your language from a dropdown;
	 * say how well you know it and agree to how ratings are used (first time only);
	 * rate one worked example and see ours next to yours; then rate stored answers one question at a
	 * time, the request and answer pinned beside the questions, with a short celebration after each.
	 * No model name and no English version are ever shown.
	 *
	 * Talks to the human evaluation API (types.ts lists it); the page and the API share the `human-eval`
	 * flag. Only `?sample=1` runs it on sample answers, labelled as such and never saved; `?scenario=`
	 * (fixtures.ts) reproduces the signed-out, daily-limit, offline and no-more-answers states.
	 */
	let { data }: { data: PageData } = $props();

	type Rateable = Extract<NextItem, { kind: 'calibration' | 'rate' }>;
	type Phase =
		| { name: 'boot' }
		| { name: 'intro' }
		| { name: 'loading' }
		| { name: 'profile'; consent: Consent }
		| { name: 'item'; item: Rateable; revealed: boolean }
		| { name: 'saved' }
		| { name: 'stopped' }
		| { name: 'done' }
		| { name: 'empty' }
		| { name: 'closed' }
		| { name: 'limit' }
		| { name: 'signed_out' }
		| { name: 'error'; message: string; retry?: () => void };

	const params = page.url.searchParams;
	const scenario = (params.get('scenario') as SampleScenario | null) ?? undefined;
	const forceSample = params.has('sample') || !!scenario;

	let api = $state<EvalApi>(httpEvalApi);
	let phase = $state<Phase>({ name: 'boot' });
	let languages = $state<EvalLanguage[]>([]);
	// Ids the service lists: the picker shows all 26, so one missing here is closed (CUR-4263).
	let openIds = $state<string[]>([]);
	let language = $state(evalLanguageId(params.get('language') ?? ''));
	const languageOptions = $derived(languages.map((l) => {
		const own = endonym(l.id);
		return { ...l, value: l.id, own, label: own && own !== l.name ? `${l.name} · ${own}` : l.name };
	}));
	const current = $derived(languages.find((l) => l.id === language));
	const languageLabel = $derived(current?.name ?? '');
	// Open, with nothing stored to rate yet (CUR-4263): said on the picker, before any consent.
	const nothingToRate = $derived(current?.hasAnswers === false);
	// Not open at all (no speaker has checked its requests): its own message, apart from open-but-empty.
	const notOpenYet = $derived(!api.sample && !!current && !openIds.includes(current.id));
	const signedIn = $derived(api.sample || data.signedIn);
	const generatedPreview = $derived(!!data.generatedSamples && !scenario);
	const sampleLanguages = $derived(generatedPreview
		? languages.filter((l) => data.generatedSamples?.items[l.id]?.length).map((l) => l.name).join(', ')
		: 'French, Arabic and Urdu');

	// Profile and consent (first time per language).
	let level = $state<DeclaredLevel | ''>('');
	let variety = $state('');
	let agreed = $state(false);

	// The answer on screen.
	let answers = $state<Record<string, string | undefined>>({});
	let selectedFlags = $state<string[]>([]);
	let comment = $state('');
	let missing = $state<string[]>([]);
	let submitting = $state(false);
	let submitError = $state('');
	let shownAt = 0;
	let started = false;
	let ratedThisVisit = $state(0);

	const loginHref = $derived(
		`${base}/login?next=${encodeURIComponent(`${page.url.pathname}${language ? `?language=${language}` : ''}`)}`
	);

	onMount(async () => {
		// Samples only when asked for: a page that quietly fell back to them looked like it saved ratings.
		const chosen: EvalApi = forceSample ? sampleEvalApi(scenario, scenario ? null : data.generatedSamples) : httpEvalApi;
		try {
			languages = await chosen.languages();
			openIds = languages.map((l) => l.id);
		} catch (err) {
			const message =
				err instanceof EvalApiError && err.kind === 'unavailable'
					? 'Evaluation isn’t open on this site right now.'
					: 'Evaluation couldn’t load. Check your connection and try again.';
			phase = { name: 'error', message, retry: () => location.reload() };
			return;
		}
		languages = evaluationLanguages(languages);
		api = chosen;
		phase = { name: 'intro' };
	});

	// The settings pane scrolls, not the window.
	let root: HTMLDivElement | undefined = $state();
	function scrollToTop(behavior: ScrollBehavior = 'auto') {
		root?.closest('[data-settings-scroll]')?.scrollTo({ top: 0, behavior });
	}

	function resetForm() {
		answers = {};
		selectedFlags = [];
		comment = '';
		missing = [];
		submitError = '';
		shownAt = performance.now();
	}

	function failed(err: unknown, retry: () => void) {
		if (err instanceof EvalApiError) {
			if (err.kind === 'signed_out') return (phase = { name: 'signed_out' });
			if (err.kind === 'closed') return (phase = { name: 'closed' });
			if (err.kind === 'network') {
				return (phase = { name: 'error', message: 'Couldn’t reach Alpha. Check your connection and try again.', retry });
			}
		}
		console.error(err);
		phase = { name: 'error', message: 'Something went wrong on our side. Try again in a moment.', retry };
	}

	async function loadNext() {
		phase = { name: 'loading' };
		try {
			show(await api.next(language));
		} catch (err) {
			failed(err, loadNext);
		}
	}

	function show(item: NextItem) {
		scrollToTop();
		switch (item.kind) {
			case 'needs_profile':
				agreed = false;
				phase = { name: 'profile', consent: item.consent };
				return;
			case 'calibration':
			case 'rate':
				if (!started) {
					started = true;
					trackEvent('human_eval_started', { language, sample: api.sample });
				}
				resetForm();
				phase = { name: 'item', item, revealed: false };
				return;
			case 'done':
				phase = { name: 'done' };
				return;
			case 'empty':
				phase = { name: 'empty' };
				return;
			case 'closed':
				phase = { name: 'closed' };
				return;
		}
	}

	function start() {
		if (!language) return;
		goto(`?${new URLSearchParams({ ...Object.fromEntries(params), language })}`, { replaceState: true, keepFocus: true, noScroll: true });
		const remembered = rememberedProfile(language);
		level = remembered?.level ?? '';
		variety = remembered?.variety ?? '';
		loadNext();
	}

	async function saveProfile(calibrationDone = false) {
		if (!level) return;
		phase = { name: 'loading' };
		try {
			await api.saveProfile({ language, level, variety: variety || null, consent: true, calibrationDone });
			rememberProfile(language, { level, variety: variety || null });
			await loadNext();
		} catch (err) {
			failed(err, () => saveProfile(calibrationDone));
		}
	}

	function pointAtMissing(keys: string[], byServer: boolean) {
		missing = keys;
		trackEvent('human_eval_refused', { language, missing: keys, by: byServer ? 'server' : 'form' });
	}

	async function submit(item: Rateable) {
		const excluded = item.kind === 'rate' && selectedFlags.some((f) => EXCLUDING_FLAGS.has(f));
		const keys = missingQuestions(item.questions, answers, excluded);
		if (keys.length) return pointAtMissing(keys, false);
		missing = [];

		// The worked example isn't stored: the person sees our rating next to theirs.
		if (item.kind === 'calibration') {
			phase = { name: 'item', item, revealed: true };
			scrollToTop('smooth');
			return;
		}

		submitting = true;
		submitError = '';
		try {
			const result = await api.rate({
				modelRunId: item.runId,
				scores: toScores(item.questions, answers),
				flags: selectedFlags,
				comment: comment.trim() || null,
				durationMs: Math.round(performance.now() - shownAt)
			});
			if (result.ok) {
				ratedThisVisit++;
				trackEvent('human_eval_submitted', { language, rated_this_visit: ratedThisVisit, sample: api.sample });
				phase = { name: 'saved' };
				return;
			}
			switch (result.reason) {
				case 'incomplete':
					return pointAtMissing(result.missing, true);
				case 'daily_limit':
					phase = { name: 'limit' };
					return;
				default:
					// Already rated, gone from the set, or the profile is missing: the next item sorts it out.
					return loadNext();
			}
		} catch (err) {
			if (err instanceof EvalApiError && err.kind === 'signed_out') return (phase = { name: 'signed_out' });
			// Everything entered stays on screen.
			submitError =
				err instanceof EvalApiError && err.kind === 'network'
					? 'Couldn’t reach Alpha, so this rating wasn’t sent. Your answers are still here: try again.'
					: 'Something went wrong on our side and this rating wasn’t saved. Your answers are still here: try again.';
		} finally {
			submitting = false;
		}
	}

	// From `/languages` (languages.json), so the page offers exactly the varieties the API accepts.
	const varieties = $derived(current?.varieties ?? []);

	/** The worked example, scored: how many of the person's answers match ours. */
	function matches(item: Extract<Rateable, { kind: 'calibration' }>) {
		return item.questions.filter((q) => String(item.expected[q.key]) === answers[q.key]).length;
	}
	function optionLabel(q: EvalQuestion, value: string | number | undefined): string {
		if (value === undefined || value === '') return 'No answer';
		if (value === CANT_TELL) return q.cantTellLabel ?? 'I can’t tell';
		const o = q.options.find((opt) => String(opt.value) === String(value));
		return o ? (q.type === 'scale' ? `${o.value} · ${o.label}` : o.label) : String(value);
	}

	const STEPS = [
		{ icon: RiChatQuoteLine, title: 'Read', text: 'A request someone made, and a model’s answer, both in your language.' },
		{ icon: RiCheckboxMultipleLine, title: 'Rate', text: 'Four quick questions. Six when it’s about health.' },
		{ icon: RiBarChart2Line, title: 'It counts', text: 'Your ratings show how each model really does in your language.' }
	];
	// Rating sets the request beside the questions, wider than the settings reading column.
	$effect(() => {
		settingsWidePage.set(phase.name === 'item');
		return () => settingsWidePage.set(false);
	});

	// Once a language is under way, the settings header reads Evaluate language › <language>, and the
	// crumb back leads to the language picker (any sample/scenario params kept).
	const inLanguage = $derived(phase.name !== 'intro' && phase.name !== 'boot' && !!languageLabel);
	const pickerQuery = [...params].filter(([k]) => k !== 'language').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
	const pickerHref = `${base}/settings/evaluate${pickerQuery ? `?${pickerQuery}` : ''}`;
	$effect(() => {
		settingsSubpage.set(inLanguage ? { label: languageLabel, parentHref: pickerHref } : undefined);
		return () => settingsSubpage.set(undefined);
	});
	// That crumb (or Back) lands on this same page without a language: return to the picker.
	afterNavigate(({ to }) => {
		if (phase.name === 'boot' || to?.url.searchParams.has('language')) return;
		language = '';
		phase = { name: 'intro' };
	});
</script>

<svelte:head>
	<meta
		name="description"
		content="Rate answers AI models gave in your language. The questions are adapted from the Multilingual AI Safety Evaluation Lab by Roya Pakzad (Taraaz)."
	/>
</svelte:head>

<div bind:this={root} data-eval-page data-eval-phase={phase.name}>
	<div class="flex w-full flex-col gap-8">
		<!-- While rating, the header names the language; this bar carries only what it can't. -->
		{#if phase.name !== 'intro' && phase.name !== 'boot' && (api.sample || ratedThisVisit)}
			<div class="flex items-center gap-3" data-eval-topbar>
				{#if api.sample}<Badge data-eval-sample>Sample data</Badge>{/if}
				<span class="flex-1"></span>
				{#if ratedThisVisit}
					<span class="type-label text-fg-3 tabular-nums" data-eval-progress>{ratedThisVisit} rated</span>
				{/if}
			</div>
		{/if}

		{#if phase.name === 'boot' || phase.name === 'loading'}
			<div class="flex items-center gap-2 py-16 type-caption text-fg-2" role="status" data-eval-loading>
				<Spinner /> Loading…
			</div>
		{:else if phase.name === 'intro'}
			<section class="flex flex-col gap-3" data-eval-intro>
				<div class="flex items-center gap-2">
					<p class="type-label text-fg-3">Help evaluate models</p>
					{#if api.sample}<Badge data-eval-sample>Sample data</Badge>{/if}
				</div>
				<h2 class="type-heading text-fg-1">Is AI any good in your language? You can tell.</h2>
				<p class="type-body text-fg-2">
					Read answers AI models gave to everyday requests, and rate them the way you’d judge them if you had asked. You
					won’t see which model wrote each one.
				</p>
			</section>

			<ol class="grid gap-2 sm:grid-cols-3" aria-label="How it works" data-eval-how>
				{#each STEPS as s, i (s.title)}
					<li class="flex flex-col gap-3 border border-line-2 bg-surface-2 p-4 rounded-card">
						<span class="flex items-center justify-between">
							<s.icon aria-hidden="true" class="size-6 text-accent-1-text" />
							<span class="type-code text-fg-3">{i + 1}</span>
						</span>
						<span class="type-title text-fg-1">{s.title}</span>
						<span class="type-caption text-fg-2">{s.text}</span>
					</li>
				{/each}
			</ol>

			<section class="flex flex-col gap-3" aria-labelledby="eval-pick-label">
				<h3 id="eval-pick-label" class="type-label text-fg-1">Pick your language</h3>
				<Select.Root bind:value={language} items={languageOptions}>
					<Select.Trigger class="w-full max-w-sm" aria-labelledby="eval-pick-label" data-eval-language>
						<Select.Value placeholder="Select a language" />
						<Select.Icon />
					</Select.Trigger>
					<Select.Portal>
						<Select.Positioner>
							<Select.Popup>
								{#each languageOptions as l (l.id)}
									<Select.Item value={l.value} label={l.label}>
										{l.name}
										{#if l.own && l.own !== l.name}
											<span class="text-fg-2"> · <bdi dir={l.dir} lang={langAttr(l.id)}>{l.own}</bdi></span>
										{/if}
									</Select.Item>
								{/each}
							</Select.Popup>
						</Select.Positioner>
					</Select.Portal>
				</Select.Root>
				<p class="type-caption text-fg-3">Evaluation opens as speakers check the requests in each language.</p>
			</section>

			{#if notOpenYet}
				<p class="type-body text-fg-2" role="status" data-eval-not-open-notice>
					Evaluation isn’t open in {languageLabel} yet. It opens once a native speaker has checked the requests.
				</p>
			{:else if nothingToRate}
				<!-- Nothing to start: no Start, and no sign-in that leads to nothing. -->
				<p class="type-body text-fg-2" role="status" data-eval-empty-notice>
					There are no answers to rate in {languageLabel} yet. We add them as models answer the requests, so check back
					soon, or pick another language.
				</p>
			{:else}
				<div class="flex flex-wrap items-center gap-3">
					{#if signedIn}
						<Button variant="primary" size="lg" casing="sentence" disabled={!language} onclick={start} data-eval-start>
							{languageLabel ? `Start in ${languageLabel}` : 'Start'} <RiArrowRightLine aria-hidden="true" />
						</Button>
					{:else}
						<Button variant="primary" size="lg" casing="sentence" href={loginHref} data-eval-signin>
							Sign in to start <RiArrowRightLine aria-hidden="true" />
						</Button>
						<span class="type-caption text-fg-2">So your ratings count once, and you can delete them later.</span>
					{/if}
				</div>
			{/if}

			{#if current}<EvalResults {api} language={current.id} label={languageLabel} />{/if}

			{#if api.sample}
				<p class="type-caption text-fg-3" data-eval-sample-note>
					{#if generatedPreview}
						These preview answers were generated by the models from evaluation requests.
					{:else}
						This is a preview on sample answers written for the page.
					{/if}
					Sample answers are available in {sampleLanguages}. Nothing you rate here is saved.
				</p>
			{/if}
			<RubricCredit credit={RUBRIC_CREDIT} compact />
		{:else if phase.name === 'profile'}
			<form
				class="flex flex-col gap-8"
				onsubmit={(e) => {
					e.preventDefault();
					saveProfile();
				}}
				data-eval-profile
			>
				<section class="flex flex-col gap-3" aria-labelledby="eval-level-label">
					<h2 id="eval-level-label" class="type-heading text-fg-1">How well do you know {languageLabel}?</h2>
					<RadioGroup bind:value={level} aria-labelledby="eval-level-label" class="grid gap-2 sm:grid-cols-3">
						{#each LEVELS as l (l.value)}
							<label
								class="relative flex cursor-pointer flex-col gap-1 border border-line-2 bg-surface-raised p-4 rounded-card transition-control hover:tint-hover has-focus-visible:outline-2 has-focus-visible:outline-fg-1 has-data-checked:border-fg-1 has-data-checked:tint-active"
							>
								<Radio.Root value={l.value} class="sr-only" />
								<span class="type-title text-fg-1">{l.label}</span>
								<span class="type-caption text-fg-2">{l.hint}</span>
							</label>
						{/each}
					</RadioGroup>
				</section>

				{#if varieties.length}
					<section class="flex flex-col gap-2" aria-labelledby="eval-variety-label">
						<h3 id="eval-variety-label" class="type-label text-fg-1">
							Which {languageLabel}? <span class="text-fg-3">(optional)</span>
						</h3>
						<ToggleGroup
							bind:value={() => (variety ? [variety] : []), (v) => (variety = v[0] ?? '')}
							aria-label="Variety of {languageLabel}"
						>
							{#each varieties as v (v.value)}<Toggle value={v.value}>{v.label}</Toggle>{/each}
						</ToggleGroup>
					</section>
				{/if}

				<section class="flex flex-col gap-3 border border-line-2 bg-surface-2 p-4 rounded-card" aria-labelledby="eval-consent-label" data-eval-consent>
					<h3 id="eval-consent-label" class="type-label text-fg-1">{phase.consent.title}</h3>
					<ul class="flex flex-col gap-2">
						{#each phase.consent.paragraphs as p, i (i)}
							<li class="flex gap-2 type-caption text-fg-2">
								<RiCheckLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-fg-3" />{p}
							</li>
						{/each}
					</ul>
					<label class="flex items-start gap-2 border-t border-line-2 pt-3 type-body text-fg-1">
						<Checkbox.Root bind:checked={agreed} class="mt-0.5" data-eval-agree><Checkbox.Indicator /></Checkbox.Root>
						{phase.consent.agree}
					</label>
				</section>

				<Button type="submit" variant="primary" size="lg" casing="sentence" class="self-start" disabled={!level || !agreed}>
					Continue <RiArrowRightLine aria-hidden="true" />
				</Button>
			</form>
		{:else if phase.name === 'item'}
			{@const item = phase.item}
			<div class="grid items-start gap-6 lg:grid-cols-2 lg:gap-10">
				<!-- The request and answer stay in view while the questions change beside them. -->
				<div class="flex flex-col gap-3 lg:sticky lg:top-4">
					{#if item.kind === 'calibration'}
						<p class="type-label text-fg-2" data-eval-calibration>Practice round · this one isn’t saved</p>
					{/if}
					<EvalExchange prompt={item.prompt} answer={item.answer} dir={item.dir} lang={langAttr(language)} />
				</div>

				<div class="flex flex-col gap-6">
					{#if item.kind === 'calibration' && phase.revealed}
						{@const score = matches(item)}
						<section class="flex flex-col gap-4" aria-labelledby="eval-reveal-label" data-eval-reveal>
							<div class="flex items-center gap-3">
								<span class="grid size-12 shrink-0 place-items-center border border-line-2 bg-surface-raised rounded-pill">
									<RiCheckboxCircleLine aria-hidden="true" class="size-6 text-accent-1-text" />
								</span>
								<div class="flex flex-col">
									<h2 id="eval-reveal-label" class="type-heading text-fg-1">
										{score === item.questions.length ? 'Spot on.' : `You matched us on ${score} of ${item.questions.length}.`}
									</h2>
									<p class="type-caption text-fg-2">It’s fine to differ. What matters is judging as if you had asked.</p>
								</div>
							</div>
							<ul class="flex flex-col divide-y divide-line-2 border border-line-2 rounded-card">
								{#each item.questions as q (q.key)}
									{@const same = String(item.expected[q.key]) === answers[q.key]}
									<li class="flex flex-col gap-1 px-3 py-2.5" data-eval-expected={q.key}>
										<span class="type-caption text-fg-2">{q.label}</span>
										<span class="flex items-center gap-2 type-body text-fg-1">
											{#if same}<RiCheckLine aria-hidden="true" class="size-4 shrink-0 text-accent-1-text" />{/if}
											{optionLabel(q, item.expected[q.key])}
										</span>
										{#if !same}<span class="type-caption text-fg-3">You said {optionLabel(q, answers[q.key])}</span>{/if}
									</li>
								{/each}
							</ul>
							<div class="flex flex-col gap-1.5 border-l-2 border-line-3 pl-3">
								<p class="type-label text-fg-2">Why</p>
								<p dir={item.dir} lang={langAttr(language)} class="type-body text-fg-1" data-eval-explanation>{item.explanation}</p>
							</div>
							<RubricCredit credit={item.credit} />
							{#if !level}
								<RadioGroup bind:value={level} aria-label="Your level of {languageLabel}" orientation="horizontal" class="flex-wrap gap-3">
									{#each LEVELS as l (l.value)}
										<label class="flex items-center gap-2 type-body"><Radio.Root value={l.value}><Radio.Indicator /></Radio.Root>{l.label}</label>
									{/each}
								</RadioGroup>
							{/if}
							<Button variant="primary" size="lg" casing="sentence" class="self-start" disabled={!level} onclick={() => saveProfile(true)} data-eval-begin>
								Start rating answers <RiArrowRightLine aria-hidden="true" />
							</Button>
						</section>
					{:else}
						{#if item.kind === 'calibration'}
							<p class="type-body text-fg-2">
								Rate this one the way you would if you had asked it yourself. Then we’ll show you how we rate it.
							</p>
						{/if}
						{#key item.kind === 'rate' ? item.runId : 'calibration'}
							<QuestionStepper
								questions={item.questions}
								bind:answers
								bind:selectedFlags
								bind:comment
								flags={item.kind === 'rate' ? item.flags : []}
								reference={item.kind === 'rate' ? item.reference : []}
								dir={item.dir}
								lang={langAttr(language)}
								{missing}
								{submitting}
								submitLabel={item.kind === 'calibration' ? 'See how we rate it' : 'Submit rating'}
								onsubmit={() => submit(item)}
							/>
						{/key}
						{#if submitError}
							<p class="type-body text-accent-2-text" role="alert" data-eval-submit-error>{submitError}</p>
						{/if}
						<RubricCredit credit={item.credit} compact={item.kind === 'rate'} />
					{/if}
				</div>
			</div>
		{:else if phase.name === 'saved'}
			<section class="flex flex-col items-start gap-6 py-6" role="status" data-eval-saved>
				<span class="grid size-16 place-items-center border border-line-2 bg-surface-raised rounded-pill">
					<RiCheckLine aria-hidden="true" class="size-8 text-accent-1-text" />
				</span>
				<div class="flex flex-col gap-2">
					{#if api.sample}
						<!-- Sample mode posts nothing, so it must not claim a save the intro says never happens. -->
						<h2 class="type-display text-fg-1">Rated. Sample ratings aren’t saved.</h2>
						<p class="type-body text-fg-2">
							That’s {ratedThisVisit} sample {ratedThisVisit === 1 ? 'answer' : 'answers'} this visit. On the real page, each rating
							counts toward how models do in {languageLabel}.
						</p>
					{:else}
						<h2 class="type-display text-fg-1">Saved. Thank you.</h2>
						<p class="type-body text-fg-2">
							That’s {ratedThisVisit} {ratedThisVisit === 1 ? 'answer' : 'answers'} in {languageLabel} this visit. Each one makes the
							picture of how models do in {languageLabel} a little sharper.
						</p>
					{/if}
				</div>
				<!-- One square per rating this visit, out of the day's limit. -->
				<div class="flex max-w-md flex-wrap gap-1" aria-hidden="true" data-eval-pips>
					{#each Array.from({ length: Math.min(DAILY_RATING_CAP, Math.max(10, ratedThisVisit)) }, (_, i) => i) as i (i)}
						<span class="size-3 rounded-sharp {i < ratedThisVisit ? 'bg-fg-1' : 'bg-line-2'}"></span>
					{/each}
				</div>
				<div class="flex flex-wrap gap-2">
					<Button variant="primary" size="lg" casing="sentence" onclick={loadNext} data-eval-next>
						Rate another <RiArrowRightLine aria-hidden="true" />
					</Button>
					<Button size="lg" casing="sentence" onclick={() => (phase = { name: 'stopped' })} data-eval-stop>Stop for now</Button>
				</div>
			</section>
		{:else if phase.name === 'stopped'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-stopped>
				<h2 class="type-heading text-fg-1">Thanks for your ratings.</h2>
				<p class="type-body text-fg-2">Come back any time: we keep your place in {languageLabel}.</p>
				<Button href={`${base}/`} casing="sentence">Back to Alpha</Button>
			</section>
			<EvalResults {api} {language} label={languageLabel} />
		{:else if phase.name === 'done'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-done>
				<h2 class="type-heading text-fg-1">You’ve rated every answer we have in {languageLabel}.</h2>
				<p class="type-body text-fg-2">Thank you. We add answers as models change, so check back later.</p>
				<Button casing="sentence" onclick={() => (phase = { name: 'intro' })}>Pick another language</Button>
			</section>
			<EvalResults {api} {language} label={languageLabel} />
		{:else if phase.name === 'empty'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-empty>
				<h2 class="type-heading text-fg-1">There are no answers to rate in {languageLabel || 'this language'} yet.</h2>
				<p class="type-body text-fg-2">We add them as models answer the requests, so check back soon, or pick another language.</p>
				<Button casing="sentence" onclick={() => ((language = ''), (phase = { name: 'intro' }))}>Pick another language</Button>
			</section>
		{:else if phase.name === 'closed'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-closed>
				{#if api.sample}
					<h2 class="type-heading text-fg-1">No sample answers in {languageLabel || 'this language'} yet.</h2>
					<p class="type-body text-fg-2">Choose {sampleLanguages} to try the evaluation.</p>
				{:else}
					<h2 class="type-heading text-fg-1">{languageLabel || 'This language'} isn’t open for evaluation yet.</h2>
					<p class="type-body text-fg-2">We open a language once a speaker has checked its requests. Pick one that’s open, or come back later.</p>
				{/if}
				<Button casing="sentence" onclick={() => ((language = ''), (phase = { name: 'intro' }))}>Pick another language</Button>
			</section>
		{:else if phase.name === 'limit'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-limit>
				<h2 class="type-heading text-fg-1">That’s today’s limit of {DAILY_RATING_CAP} ratings.</h2>
				<p class="type-body text-fg-2">Thank you. You can rate more tomorrow.</p>
				<Button href={`${base}/`} casing="sentence">Back to Alpha</Button>
			</section>
		{:else if phase.name === 'signed_out'}
			<section class="flex flex-col items-start gap-3 py-6" data-eval-signed-out>
				<h2 class="type-heading text-fg-1">Sign in to rate answers.</h2>
				<p class="type-body text-fg-2">You’ll come back here, in {languageLabel || 'the same language'}.</p>
				<Button variant="primary" casing="sentence" href={loginHref}>Sign in</Button>
			</section>
		{:else if phase.name === 'error'}
			<section class="flex flex-col items-start gap-3 py-6" role="alert" data-eval-error>
				<p class="type-body text-fg-1">{phase.message}</p>
				{#if phase.retry}<Button casing="sentence" onclick={phase.retry}>Try again</Button>{/if}
			</section>
		{/if}
	</div>
</div>

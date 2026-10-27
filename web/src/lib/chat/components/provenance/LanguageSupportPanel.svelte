<script lang="ts">
	import { fly } from 'svelte/transition';
	import { prefersReducedMotion } from 'svelte/motion';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { base } from '$lib/chat/paths';
	import { orgs, type CatalogModel } from '$lib/chat/routing/catalog';
	import { fromIso1, localLanguageName } from '$lib/chat/routing/languages';
	import { specialists, type languageCoverage } from '$lib/chat/routing/coverage';
	import type { EmbeddedIntent } from '$lib/chat/types/EmbeddedIntent';
	import { Button } from '@aipotluck/alpha-ds';
	import LanguageDataActions from '$lib/chat/components/language-data/LanguageDataActions.svelte';
	import OrgLogo from './OrgLogo.svelte';
	import RiSeedlingLine from '~icons/ri/seedling-line';
	import RiArrowRightLine from '~icons/ri/arrow-right-line';

	/**
	 * The composer's Languages pill panel. One idea, shown rather than listed: Auto sends each message
	 * to the model it would pick for that language (coverage.ts, the same `route()` as the composer).
	 *
	 *   - a line cycles "language → Auto's pick for a typical message in it", taking turns across the
	 *     models; with a draft it shows the language Alpha read and the model Auto chose instead;
	 *   - under it, one thin bar split by how many languages each model Auto picks, with the model on
	 *     the line above lit, so the two move together;
	 *   - with a draft, the ways to help Alpha in its language, one tile each (as in the "still
	 *     learning" panel), since every language can use more data and better models;
	 *   - one sentence for the languages still below the dependable line, and a way to help.
	 */
	let {
		coverage,
		placeholder = false,
		live,
		embeddedDemo = false,
		onEmbeddedNavigate
	}: {
		/** The served models' languages, split at the router's dependable line (routing/coverage.ts). */
		coverage: ReturnType<typeof languageCoverage>;
		/** The language numbers are hand-set estimates. */
		placeholder?: boolean;
		/** Auto's read of the draft: the language it detected and the model it chose. */
		live?: { tag: string; model: CatalogModel };
		embeddedDemo?: boolean;
		onEmbeddedNavigate?: (intent?: EmbeddedIntent) => void;
	} = $props();

	const locale = getLocale();
	const reduceMotion = $derived(prefersReducedMotion.current);
	const groups = $derived(specialists(coverage.strong));
	const autoPicks = $derived([...coverage.strong, ...coverage.learning]);

	let index = $state(0);
	$effect(() => {
		if (live || reduceMotion || groups.cycle.length < 2) return;
		const t = setInterval(() => (index = (index + 1) % groups.cycle.length), 2600);
		return () => clearInterval(t);
	});
	const shown = $derived(
		live
			? { name: localLanguageName(live.tag, locale), model: live.model, live: true }
			: groups.cycle.length
				? { ...groups.cycle[index % groups.cycle.length], live: false }
				: undefined
	);
	const shownKey = $derived(shown ? `${shown.name}|${shown.model.id}` : '');
	const total = $derived(groups.byModel.reduce((n, g) => n + g.count, 0));

	// "Help it learn" opens Contribute already set to the person's language: the one Auto read in the
	// draft, else the interface's. English, which has no data gap to fill, carries none.
	const helpLanguage = $derived(live?.tag ?? fromIso1(locale.split('-')[0]));
	const helpHref = $derived(
		`${base}/settings/contribute${helpLanguage && helpLanguage !== 'eng' ? `?language=${encodeURIComponent(helpLanguage)}` : ''}`
	);

	// "Māori, Quechua and 3 more": a short sentence, never a second list.
	const learningText = $derived.by(() => {
		const names = coverage.learning.map((l) => l.name);
		const listed = names.length <= 4 ? names : [...names.slice(0, 3), m.product_languagesMore({ count: names.length - 3 })];
		try {
			return new Intl.ListFormat(locale, { type: 'conjunction' }).format(listed);
		} catch {
			return listed.join(', ');
		}
	});
</script>

<div class="flex flex-col gap-5" data-language-support-panel>
	{#each autoPicks as l (l.tag)}
		<span hidden data-auto-pick={l.tag} data-model={l.model.id}></span>
	{/each}
	<!-- Only the heading clears the panel's close button; everything below runs full width. -->
	<div class="flex flex-col gap-1 pr-6">
		<h2 class="type-body text-fg-1">{m.product_languagesTitle()}</h2>
		<p class="type-caption text-fg-2">{m.product_languagesIntro()}</p>
	</div>

	{#if shown}
		<div class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<span class="type-label text-fg-3">{shown.live ? m.product_languagesYourMessage() : m.product_languagesStrongest()}</span>
				<div class="relative h-9 overflow-hidden" aria-live="polite" data-language-support-preview>
					{#key shownKey}
						<span
							class="absolute inset-0 flex items-center gap-2.5"
							in:fly={{ y: reduceMotion ? 0 : 16, duration: reduceMotion ? 0 : 340, opacity: 0 }}
							out:fly={{ y: reduceMotion ? 0 : -16, duration: reduceMotion ? 0 : 240, opacity: 0 }}
						>
							<span class="truncate type-subhead text-fg-1">{shown.name}</span>
							<RiArrowRightLine aria-hidden="true" class="size-4 shrink-0 text-fg-3" />
							<span class="flex min-w-0 items-center gap-1.5 type-body text-fg-2">
								<OrgLogo org={orgs[shown.model.maker]} size="xs" />
								<span class="truncate">{shown.model.name}</span>
							</span>
						</span>
					{/key}
				</div>
			</div>

			{#if groups.byModel.length > 1}
				<!-- How the well-handled languages are shared out: one segment per model, as wide as the
				     number of languages it is strongest in, the model on the line above lit. -->
				<figure class="flex flex-col gap-2" data-languages-specialists>
					<div class="flex h-1.5 w-full gap-0.5" aria-hidden="true">
						{#each groups.byModel as g (g.model.id)}
							<span
								class="h-full bar-width rounded-pill transition-control {shown?.model.id === g.model.id ? 'bg-fg-1' : 'bg-line-2'}"
								style:--bar-width="{(g.count / total) * 100}%"
							></span>
						{/each}
					</div>
					<figcaption class="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-fg-3">
						<span>{m.product_languagesShared({ count: total, total: coverage.strong.length + coverage.learning.length, models: groups.byModel.length })}</span>
						<span class="flex items-center gap-1.5" aria-hidden="true">
							{#each groups.byModel as g (g.model.id)}
								<span
									class="transition-control {shown?.model.id === g.model.id ? 'opacity-100' : 'opacity-40'}"
									title={m.product_languagesLeads({ model: g.model.name, count: g.count })}
								>
									<OrgLogo org={orgs[g.model.maker]} size="xs" />
								</span>
							{/each}
						</span>
					</figcaption>
				</figure>
			{/if}
		</div>
	{/if}

	{#if live && !embeddedDemo}
		<section class="flex flex-col gap-2.5 border-t border-line-surface pt-4" aria-labelledby="languages-help-heading" data-languages-contribute>
			<div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h3 id="languages-help-heading" class="type-body text-fg-1">
					{m.languageData_helpHeadingBetter({ language: shown?.name ?? '' })}
				</h3>
				<Button href={helpHref} variant="link" size="sm" casing="sentence" class="shrink-0" data-languages-more>
					{m.chat_otherWaysToHelp()} <RiArrowRightLine aria-hidden="true" />
				</Button>
			</div>
			<LanguageDataActions
				language={live.tag}
				name={shown?.name ?? ''}
				surface="composer_languages_panel"
				layout="tiles"
				strongModel={coverage.strong.find((l) => l.tag === live.tag)?.model.name}
			/>
		</section>
	{/if}

	<div class="flex flex-col gap-1.5 border-t border-line-surface pt-3">
		{#if coverage.learning.length}
			<p class="flex items-start gap-1.5 type-caption text-fg-2" data-languages-learning>
				<RiSeedlingLine aria-hidden="true" class="mt-0.5 size-3.5 shrink-0 text-accent-1-text" />
				<span>
					{m.product_languagesStillLearning({ languages: learningText })}
					<a
						href={helpHref}
						class="whitespace-nowrap text-fg-1 underline decoration-line-3 underline-offset-2 hover:decoration-fg-1"
						data-languages-help
						onclick={(e) => {
							if (!embeddedDemo) return;
							e.preventDefault();
							onEmbeddedNavigate?.({ kind: 'app', label: m.chat_waysToContribute() });
						}}>{m.product_languagesHelp()}</a
					>
				</span>
			</p>
		{/if}
		<p class="type-caption text-fg-3" data-languages-source>
			{placeholder ? m.product_languagesSourcePlaceholder() : m.product_languagesSource()}
		</p>
	</div>
</div>

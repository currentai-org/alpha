<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import type { Component } from "svelte";
	import { Badge, Button, Collapsible, Combobox, Field, VisuallyHidden, fuzzyFilter } from "@aipotluck/alpha-ds";
	import { base } from "$lib/chat/paths";
	import { trackEvent } from "$lib/analytics";
	import { APERTUS, MISTRAL, MOZILLA_DATA_COLLECTIVE } from "$lib/chat/contribute";
	import { commonVoiceLanguagesHref } from "$lib/chat/commonVoice";
	import { LAUNCH_LANGUAGES, partnerHref } from "$lib/chat/languageData";
	import { fromIso1, languageName, localLanguageName } from "$lib/chat/routing/languages";
	import { getLocale } from "$lib/paraglide/runtime.js";
	import { recentLanguageGap } from "$lib/chat/routing/state";
	import { settingsDevTools } from "$lib/chat/settingsSections";
	import ReportProblemDialog from "$lib/chat/components/ReportProblemDialog.svelte";
	import OrgMention from "$lib/chat/components/provenance/OrgMention.svelte";
	import LanguageDataActions from "$lib/chat/components/language-data/LanguageDataActions.svelte";
	import HelpTile from "$lib/chat/components/language-data/HelpTile.svelte";
	import RiMicLine from "~icons/ri/mic-line";
	import RiDatabase2Line from "~icons/ri/database-2-line";
	import RiArrowRightSLine from "~icons/ri/arrow-right-s-line";
	import { orgs, type Org } from "$lib/chat/routing/catalog";
	import RiFlaskLine from "~icons/ri/flask-line";
	import RiChatCheckLine from "~icons/ri/chat-check-line";
	import RiLightbulbFlashLine from "~icons/ri/lightbulb-flash-line";
	import RiSeedlingLine from "~icons/ri/seedling-line";
	import RiArrowRightUpLine from "~icons/ri/arrow-right-up-line";
	import RiArrowRightLine from "~icons/ri/arrow-right-line";
	import RiCheckLine from "~icons/ri/check-line";
	import { page } from "$app/state";
	import type { PageData } from "./$types";

	// Settings → Contribute: the real ways to help fill Alpha's gaps, starting with data for a
	// language Alpha is weak in (helping build a dataset on Common Voice first, since nearly anyone can,
	// then sharing an existing one through the Mozilla Data Collective), then evaluating answers, then
	// the roadmap's open pieces. The sidebar's
	// "Get involved" card and the composer's language-gap notice both land here.
	let { data }: { data: PageData } = $props();

	let reportOpen = $state(false);

	// The language the data section is about: the one a link brought (the composer's Language panel
	// sends the person's), else the one the composer last noticed a gap in, else the browser's, else
	// the person picks. Every link and event below carries it. `OTHER` is "my language isn't listed":
	// Common Voice's own list, and a form that tells us which language was missing.
	const OTHER = "other";
	const linkedLanguage = (() => {
		const tag = page.url.searchParams.get("language");
		return tag && /^[a-z]{3}(-[A-Za-z0-9]{2,8})?$/.test(tag) && tag !== "eng" ? tag : undefined;
	})();
	const browserLanguage =
		typeof navigator === "undefined" ? undefined : fromIso1(navigator.language.split("-")[0].toLowerCase());
	// The searchable languages, each also found by its English name, its own name and its code. "My
	// language isn't listed" is not among them: it stays below the matches whatever is typed.
	const searchableLanguages = $derived.by(() => {
		const tags = [
			...LAUNCH_LANGUAGES,
			...($recentLanguageGap ? [$recentLanguageGap.tag] : []),
			...(linkedLanguage ? [linkedLanguage] : []),
		];
		return [...new Set(tags.filter((t) => t !== "eng"))]
			.map((tag) => ({
				value: tag,
				label: localLanguageName(tag, getLocale()),
				keywords: [languageName(tag), localLanguageName(tag, tag.split("-")[0]), tag],
			}))
			.sort((a, b) => a.label.localeCompare(b.label, getLocale()));
	});
	const otherOption = $derived({ value: OTHER, label: m.contribute_languageMissing() });
	const languageOptions = $derived([...searchableLanguages, otherOption]);
	let languageQuery = $state("");
	const languageMatches = $derived(fuzzyFilter(searchableLanguages, languageQuery));
	let language = $state(
		linkedLanguage ??
			$recentLanguageGap?.tag ??
			(browserLanguage && browserLanguage !== "eng" && (LAUNCH_LANGUAGES as readonly string[]).includes(browserLanguage)
				? browserLanguage
				: "")
	);
	const languageLabel = $derived(language && language !== OTHER ? localLanguageName(language, getLocale()) : "");

	// "My language isn't listed": the name as the person writes it, stored as a `data_interest` row
	// with language `und`, so the languages people ask for can be counted.
	let termsOpen = $state(false);
	let missingName = $state("");
	let missingEmail = $state("");
	let missingStatus = $state<"idle" | "sending" | "sent" | "failed">("idle");
	async function submitMissing(e: SubmitEvent) {
		e.preventDefault();
		if (missingStatus === "sending" || !missingName.trim()) return;
		missingStatus = "sending";
		try {
			const res = await fetch(`${base}/api/contribute`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "data_interest",
					language: "und",
					languageName: missingName.trim(),
					email: missingEmail.trim() || null,
				}),
			});
			if (!res.ok) throw new Error(`contribute failed: ${res.status}`);
			missingStatus = "sent";
			trackEvent("language_missing_submitted", { surface: "contribute_page", with_email: !!missingEmail.trim() });
		} catch (err) {
			console.error(err);
			missingStatus = "failed";
		}
	}

	type Way = {
		id: string;
		icon: Component;
		title: string;
		body: string;
		/** The partner the way runs through, credited after the body. */
		partner?: Org;
		actions: { label: string; href?: string; external?: boolean; onclick?: () => void }[];
		/** For an external action: the partner it opens, named in the "you're leaving Alpha" line. */
		leavesFor?: Org;
	};

	// Splits a translated sentence around `{org}` (and `{voice}`) so an OrgMention can stand in each
	// spot, in any word order.
	const aroundOrg = (text: string) => text.split(/(\{org\}|\{voice\})/).filter(Boolean);

	const evaluate: Way = $derived(
		data.evaluationOpen
			? {
					id: "evaluate",
					icon: RiChatCheckLine,
					title: languageLabel ? m.contribute_evaluateIn({ language: languageLabel }) : m.contribute_evaluateYours(),
					body: m.contribute_evaluateBody(),
					actions: [
						{
							label: m.contribute_startEvaluating(),
							href: `${base}/settings/evaluate${language ? `?language=${language}` : ""}`,
							onclick: () => trackEvent("human_eval_cta_clicked", { surface: "contribute_page", language: language || null }),
						},
					],
				}
			: {
					id: "benchmarks",
					icon: RiFlaskLine,
					title: m.contribute_benchmarksTitle(),
					body: m.contribute_benchmarksBody(),
					actions: [{ label: m.contribute_openRouting(), href: `${base}/settings/routing` }],
				}
	);

	const ways: Way[] = $derived([
		evaluate,
		{
			id: "feedback",
			icon: RiLightbulbFlashLine,
			title: m.contribute_feedbackTitle(),
			body: m.contribute_feedbackBody(),
			actions: [{ label: m.contribute_tellUs(), onclick: () => (reportOpen = true) }],
		},
	]);
	// The benchmarks way is about Auto's scores and opens Model routing, so it shows only where Auto (the
	// `auto-routing` flag) is on and the visitor has developer tools, the routing page's own gate.
	const shownWays = $derived(
		page.data.autoRoutingEnabled === true && settingsDevTools(page.data) ? ways : ways.filter((w) => w.id !== "benchmarks")
	);

	const statusLabel: Record<string, string> = $derived({ missing: m.contribute_statusMissing(), building: m.contribute_statusBuilding() });
	const humanise = (slug: string) => {
		const s = slug.replace(/-/g, " ");
		return s.charAt(0).toUpperCase() + s.slice(1);
	};
	const linkClass =
		"inline-flex items-center gap-1.5 type-caption text-fg-2 underline decoration-line-3 underline-offset-2 hover:text-fg-1";
</script>

<div class="flex flex-col gap-8" data-contribute>
	<p class="type-body text-fg-2">
		{m.contribute_intro()}
	</p>

	<section
		class="seed-band relative flex gap-3 border border-line-2 bg-surface-raised p-4 rounded-card"
		aria-labelledby="data-heading"
		data-contribute-data={language || "none"}
	>
		<RiSeedlingLine aria-hidden="true" class="mt-0.5 size-5 shrink-0 text-accent-1-text" />
		<div class="flex min-w-0 flex-1 flex-col gap-3">
			<div class="flex flex-col gap-1">
				<h2 id="data-heading" class="type-label text-fg-1">
					{languageLabel ? m.contribute_dataIn({ language: languageLabel }) : m.contribute_dataYours()}
				</h2>
				{#if $recentLanguageGap && $recentLanguageGap.tag === language}
					<p class="type-body text-fg-2" data-contribute-gap={$recentLanguageGap.tag}>
						{m.contribute_gapNotice({ language: localLanguageName($recentLanguageGap.tag, getLocale()), percent: Math.round($recentLanguageGap.bestAvailable * 100) })}
					</p>
				{/if}
				<p class="type-body text-fg-2">{m.contribute_dataLead()}</p>
			</div>
			<Field.Root class="max-w-xs">
				<Field.Label>{m.product_language()}</Field.Label>
				<Combobox.Root
					bind:value={language}
					items={languageOptions}
					inputValue={languageOptions.find((option) => option.value === language)?.label ?? ""}
					onOpenChange={(open) => {
						if (!open) languageQuery = "";
					}}
				>
					<Combobox.Input
						data-contribute-language
						placeholder={m.contribute_pickLanguage()}
						triggerLabel={m.contribute_showLanguages()}
						oninput={(e) => (languageQuery = e.currentTarget.value)}
					/>
					<Combobox.Portal>
						<Combobox.Positioner>
							<Combobox.Popup>
								{#each languageMatches as option (option.value)}
									<Combobox.Item value={option.value} label={option.label} />
								{:else}
									<Combobox.Empty>{m.contribute_noLanguageMatch()}</Combobox.Empty>
								{/each}
								<Combobox.Separator />
								<Combobox.Item value={otherOption.value} label={otherOption.label} data-contribute-language-missing />
							</Combobox.Popup>
						</Combobox.Positioner>
					</Combobox.Portal>
				</Combobox.Root>
			</Field.Root>
			{#if language && language !== OTHER}
				<LanguageDataActions {language} name={languageLabel} surface="contribute_page" layout="tiles" leavingNote={false} />
			{:else}
				<!-- No language yet: Common Voice's own list, where the person finds theirs, and the Data
				     Collective's contribute page for someone who already has a dataset in any language. -->
				<div class="flex flex-col gap-2" data-contribute-data-fallback>
					<div class="grid gap-2 sm:grid-cols-2">
						<HelpTile
							href={partnerHref(commonVoiceLanguagesHref(getLocale()), { language: "und", surface: "contribute_page" })}
							icon={RiMicLine}
							title={m.contribute_buildDatasetYours()}
							hint={m.contribute_buildDatasetYoursHint()}
							onclick={() => trackEvent("mdc_cta_clicked", { surface: "contribute_page", destination: "cv_languages", language: "und" })}
							data-language-data-action="cv_languages"
						>
							<VisuallyHidden>{m.contribute_opensPartnerTab()}</VisuallyHidden>
						</HelpTile>
						<HelpTile
							href={partnerHref(MOZILLA_DATA_COLLECTIVE.contributeLanguage, { language: "und", surface: "contribute_page" })}
							icon={RiDatabase2Line}
							title={m.contribute_shareDatasetYouHave()}
							hint={m.contribute_shareDatasetYouHaveHint()}
							onclick={() => trackEvent("mdc_cta_clicked", { surface: "contribute_page", destination: "mdc_share", language: "und" })}
							data-language-data-action="mdc_share"
						>
							<VisuallyHidden>{m.contribute_opensPartnerTab()}</VisuallyHidden>
						</HelpTile>
					</div>
					{#if language === OTHER}
						{#if missingStatus === "sent"}
							<p class="flex items-center gap-1.5 type-caption text-fg-2" role="status" data-contribute-missing-sent>
								<RiCheckLine aria-hidden="true" class="size-3.5 shrink-0" />
								{m.contribute_languageMissingThanks({ language: missingName.trim() })}
							</p>
						{:else}
							<form class="flex max-w-xs flex-col gap-2" onsubmit={submitMissing} data-contribute-missing>
								<p class="type-caption text-fg-2">{m.contribute_languageMissingBody()}</p>
								<Field.Root>
									<Field.Label>{m.contribute_languageMissingName()}</Field.Label>
									<Field.Control bind:value={missingName} required maxlength={120} autocomplete="off" />
								</Field.Root>
								<Field.Root>
									<Field.Label>{m.languageData_emailOptional()}</Field.Label>
									<Field.Control type="email" bind:value={missingEmail} autocomplete="email" placeholder="you@example.org" />
									<Field.Description>{m.contribute_languageMissingEmailHelp()}</Field.Description>
								</Field.Root>
								<div class="flex flex-wrap items-center gap-2">
									<Button type="submit" size="sm" casing="sentence" disabled={missingStatus === "sending" || !missingName.trim()}>
										{m.contribute_languageMissingSubmit()}
									</Button>
									{#if missingStatus === "failed"}
										<span class="type-caption text-fg-2" role="alert">{m.languageData_failed()}</span>
									{/if}
								</div>
							</form>
						{/if}
					{/if}
				</div>
			{/if}
			<!-- Who the partners are and what happens to what you add: the partners named with their logos,
			     the open-release caveat always in view, the rest a click away. -->
			<div class="flex flex-col gap-1 border-t border-line-1 pt-3" data-contribute-data-terms>
				<p class="type-caption text-fg-3">
					{#each aroundOrg(m.contribute_dataPartners({ voice: "{voice}", org: "{org}" })) as part, i (i)}{#if part === "{voice}"}<OrgMention org={orgs["common-voice"]} />{:else if part === "{org}"}<OrgMention org={orgs["mozilla-data-collective"]} />{:else}{part}{/if}{/each}
				</p>
				<Collapsible.Root bind:open={termsOpen}>
					<Collapsible.Trigger>
						<RiArrowRightSLine aria-hidden="true" class={termsOpen ? "rotate-90" : ""} />
						<span class="type-caption text-fg-2">{m.contribute_dataTermsMore()}</span>
					</Collapsible.Trigger>
					<Collapsible.Panel>
						<p class="border-l-2 border-line-2 py-1 pl-3 type-caption text-fg-2">
							{#each aroundOrg(m.contribute_dataBody({ voice: "{voice}", org: "{org}" })) as part, i (i)}{#if part === "{voice}"}<OrgMention org={orgs["common-voice"]} />{:else if part === "{org}"}<OrgMention org={orgs["mozilla-data-collective"]} />{:else}{part}{/if}{/each}
						</p>
					</Collapsible.Panel>
				</Collapsible.Root>
			</div>
		</div>
	</section>

	<section class="flex flex-col gap-3" aria-labelledby="ways-heading">
		<h2 id="ways-heading" class="type-label text-fg-1">{m.contribute_waysTitle()}</h2>
		<ul
			data-surface="2"
			class="flex flex-col divide-y divide-line-surface border border-line-2 bg-surface-2 rounded-card"
		>
			{#each shownWays as way (way.id)}
				<li class="flex gap-3 p-4" data-contribute-way={way.id}>
					<way.icon aria-hidden="true" class="mt-0.5 size-5 shrink-0 text-fg-2" />
					<div class="flex min-w-0 flex-1 flex-col gap-3">
						<div class="flex flex-col gap-1">
							<h3 class="type-body text-fg-1">{way.title}</h3>
							<p class="type-caption text-fg-2">
								{way.body} {#if way.partner}<OrgMention org={way.partner} />.{/if}
							</p>
						</div>
						<div class="flex flex-wrap gap-2">
							{#each way.actions as action (action.label)}
								{#if action.href}
									<Button
										href={action.href}
										target={action.external ? "_blank" : undefined}
										rel={action.external ? "noreferrer" : undefined}
										size="sm"
										casing="sentence"
										onclick={action.onclick}
									>
										{action.label}
										{#if action.external}<VisuallyHidden>{m.contribute_opensPartnerTab()}</VisuallyHidden
											><RiArrowRightUpLine aria-hidden="true" />{:else}<RiArrowRightLine aria-hidden="true" />{/if}
									</Button>
								{:else}
									<Button size="sm" casing="sentence" onclick={action.onclick}>{action.label}</Button>
								{/if}
							{/each}
						</div>
						{#if way.leavesFor}
							<p class="type-caption text-fg-3">
								{#each aroundOrg(m.contribute_leavesFor({ org: "{org}" })) as part, i (i)}{#if part === "{org}" && way.leavesFor}<OrgMention org={way.leavesFor} />{:else}{part}{/if}{/each}
							</p>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	</section>

	{#if data.openGaps.length}
		<section class="flex flex-col gap-3" aria-labelledby="roadmap-heading">
			<div class="flex flex-col gap-1">
				<h2 id="roadmap-heading" class="type-label text-fg-1">{m.contribute_roadmapTitle()}</h2>
				<p class="type-caption text-fg-2">{m.contribute_roadmapHelp()}</p>
			</div>
			<ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
				{#each data.openGaps as item (item.id)}
					<li class="flex flex-col gap-1.5 border border-line-2 p-3 rounded-card" data-contribute-roadmap={item.name}>
						<!-- Titles wrap rather than truncate; on a narrow card the badge drops beneath. -->
						<div class="flex flex-wrap items-start gap-x-2 gap-y-1">
							{#if item.emoji}<span aria-hidden="true">{item.emoji}</span>{/if}
							<span class="min-w-0 flex-1 basis-40 type-body text-fg-1">{humanise(item.name)}</span>
							{#if item.status && statusLabel[item.status]}
								<Badge class="shrink-0">{statusLabel[item.status]}</Badge>
							{/if}
						</div>
						{#if item.description}<p class="type-caption text-fg-2">{item.description}</p>{/if}
					</li>
				{/each}
			</ul>
			<div class="flex flex-wrap gap-x-4 gap-y-2">
				<a href="/roadmap-v2" class={linkClass}><RiArrowRightLine aria-hidden="true" class="size-3.5" /> {m.contribute_seeRoadmap()}</a>
				<a href="/map" class={linkClass}><RiArrowRightLine aria-hidden="true" class="size-3.5" /> {m.contribute_exploreGapMap()}</a>
			</div>
		</section>
	{/if}

	<section class="flex flex-col gap-2" aria-labelledby="upstream-heading">
		<h2 id="upstream-heading" class="type-label text-fg-1">{m.contribute_upstreamTitle()}</h2>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			<a href={MISTRAL.models} target="_blank" rel="noreferrer" class={linkClass}>
				<RiArrowRightUpLine aria-hidden="true" class="size-3.5" /> {m.contribute_mistralModels()}
			</a>
			<a href={APERTUS.models} target="_blank" rel="noreferrer" class={linkClass}>
				<RiArrowRightUpLine aria-hidden="true" class="size-3.5" /> {m.contribute_apertusModels()}
			</a>
			<a href={APERTUS.report} target="_blank" rel="noreferrer" class={linkClass}>
				<RiArrowRightUpLine aria-hidden="true" class="size-3.5" /> {m.contribute_apertusTrained()}
			</a>
			<span class="type-caption text-fg-2">
				{#each aroundOrg(m.contribute_joinCommunity({ org: "{org}" })) as part, i (i)}{#if part === "{org}"}<OrgMention org={orgs["mozilla-data-collective"]} href={MOZILLA_DATA_COLLECTIVE.community} />{:else}{part}{/if}{/each}
			</span>
		</div>
	</section>
</div>

<ReportProblemDialog bind:open={reportOpen} title={m.contribute_tellMissing()} initialCategory="other" />

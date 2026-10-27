<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime.js';
	import { tick, untrack } from 'svelte';
	import { Button, Field, VisuallyHidden } from '@aipotluck/alpha-ds';
	import { base } from '$lib/chat/paths';
	import { trackEvent } from '$lib/analytics';
	import { orgs } from '$lib/chat/routing/catalog';
	import OrgMention from '$lib/chat/components/provenance/OrgMention.svelte';
	import HelpTile from './HelpTile.svelte';
	import {
		DATA_PARTNERS,
		actionLabel,
		languageDataFor,
		offersInterest,
		partnerHref,
		type DataSurface
	} from '$lib/chat/languageData';
	import RiArrowLeftLine from '~icons/ri/arrow-left-line';
	import RiArrowRightUpLine from '~icons/ri/arrow-right-up-line';
	import RiCheckLine from '~icons/ri/check-line';
	import RiCpuLine from '~icons/ri/cpu-line';
	import RiDatabase2Line from '~icons/ri/database-2-line';
	import RiHandHeartLine from '~icons/ri/hand-heart-line';
	import RiMicLine from '~icons/ri/mic-line';

	/**
	 * The data call-to-action for one language, wherever Alpha shows one: Common Voice first (its
	 * recording screen for the language, or its form to add the language), then the partner actions from
	 * languageData.ts (each link carrying the language, `utm_source=aipotluck` and the surface), a
	 * line saying the link leaves Alpha for a partner site, then two small forms through
	 * /chat/api/contribute: "tell us you want to help with [language] data" (when the language's entry
	 * offers it), counted per language, and "know a model that does [language] well?", stored as a
	 * `model_suggestion`.
	 *
	 * `layout="tiles"` (the composer's language panel) shows each of those as one tile in a grid, a
	 * title and a line on what it involves, and opens a form in place of the grid; `inline` (the
	 * default) is a row of buttons and two links.
	 *
	 * Events, each with `surface` and `language`: `mdc_cta_shown` once per language shown,
	 * `mdc_cta_clicked` with the action as `destination`, `data_interest_submitted` and
	 * `model_suggestion_submitted` (each with `with_email`).
	 */
	let {
		language,
		name,
		surface,
		layout = 'inline',
		strongModel,
		leavingNote = true
	}: {
		/** Routing language tag (ISO 639-3, optional variety). */
		language: string;
		/** The language's name, as the person reads it. */
		name: string;
		surface: DataSurface;
		layout?: 'inline' | 'tiles';
		/** A model that already handles the language well: the model question becomes "know a better one?". */
		strongModel?: string;
		/** Tiles layout: the "opens Common Voice and the Data Collective" line under the grid. Off where the
		 *  page around it already names the partners. */
		leavingNote?: boolean;
	} = $props();
	const modelTitle = $derived(
		strongModel ? m.languageData_betterModel({ language: name }) : m.languageData_suggestModel({ language: name })
	);

	const entry = $derived(languageDataFor(language, getLocale()));
	const partners = $derived([...new Set(entry.actions.map((a) => a.partner))]);
	// The default actions' labels are translated; a per-language entry's own label stays as written.
	const TRANSLATED: Record<string, (p: { language: string }) => string> = {
		cv_speak: m.languageData_commonVoice,
		cv_in_progress: m.languageData_commonVoiceInProgress,
		cv_request: m.languageData_commonVoiceRequest,
		mdc_share: m.languageData_share
	};
	const labelFor = (action: (typeof entry.actions)[number]) =>
		TRANSLATED[action.id]?.({ language: name }) ?? actionLabel(action, name);

	$effect(() => {
		const tag = language;
		const shown = entry.actions.length > 0;
		untrack(() => {
			if (shown) trackEvent('mdc_cta_shown', { surface, language: tag });
		});
	});

	// Two forms, one idea each: "tell us you'd help" (an email, optional) and "know a model that does
	// [language] well?" (the model, and an optional email). Each opens in place of the choices.
	let form = $state<'none' | 'interest' | 'model'>('none');
	let formEl = $state<HTMLFormElement>();
	async function open(which: 'interest' | 'model') {
		form = which;
		status = 'idle';
		await tick();
		formEl?.querySelector<HTMLInputElement>('input')?.focus();
	}
	let email = $state('');
	let model = $state('');
	let status = $state<'idle' | 'sending' | 'sent' | 'failed'>('idle');
	// A new language starts over; the email typed so far is kept, the model (one language's) is not.
	$effect(() => {
		void language;
		untrack(() => {
			form = 'none';
			status = 'idle';
			model = '';
		});
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (status === 'sending' || (form === 'model' && !model.trim())) return;
		status = 'sending';
		const withEmail = !!email.trim();
		try {
			const res = await fetch(`${base}/api/contribute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(
					form === 'model'
						? { kind: 'model_suggestion', language, model: model.trim(), email: email.trim() || null }
						: { kind: 'data_interest', language, email: email.trim() || null }
				)
			});
			if (!res.ok) throw new Error(`contribute failed: ${res.status}`);
			status = 'sent';
			if (form === 'model') {
				model = '';
				trackEvent('model_suggestion_submitted', { surface, language, with_email: withEmail });
			} else {
				trackEvent('data_interest_submitted', { surface, language, with_email: withEmail });
			}
		} catch (err) {
			console.error(err);
			status = 'failed';
		}
	}

	// The tiles layout's words for each data action: a short title and what it involves.
	const VOICE = new Set(['cv_speak', 'cv_in_progress', 'cv_request']);
	const hintFor = (action: (typeof entry.actions)[number]) =>
		VOICE.has(action.id)
			? m.languageData_voiceHint()
			: action.id === 'mdc_share'
				? m.languageData_shareHint()
				: DATA_PARTNERS[action.partner].name;
</script>

{#snippet formFields()}
	{#if form === 'model'}
		<Field.Root data-language-data-model>
			<Field.Label>{strongModel ? m.languageData_betterModelLabel({ language: name, model: strongModel }) : m.languageData_modelLabel({ language: name })}</Field.Label>
			<Field.Control type="text" bind:value={model} required maxlength={200} placeholder={m.languageData_modelPlaceholder()} />
		</Field.Root>
	{:else if !entry.actions.length}
		<p class="type-caption text-fg-2">{m.languageData_noProject({ language: name })}</p>
	{/if}
	<Field.Root>
		<Field.Label>{m.languageData_emailOptional()}</Field.Label>
		<Field.Control type="email" bind:value={email} autocomplete="email" placeholder="you@example.org" />
		<Field.Description>{m.languageData_emailHelp({ language: name })}</Field.Description>
	</Field.Root>
	<div class="flex flex-wrap items-center gap-2">
		<Button type="submit" size="sm" casing="sentence" disabled={status === 'sending'}>
			{form === 'model' ? m.languageData_modelSubmit() : m.languageData_submit({ language: name })}
		</Button>
		{#if status === 'failed'}
			<span class="type-caption text-fg-2" role="alert">{m.languageData_failed()}</span>
		{/if}
	</div>
{/snippet}

{#snippet thanks()}
	<p class="flex items-center gap-1.5 type-caption text-fg-2" role="status" data-language-data-interest-sent>
		<RiCheckLine aria-hidden="true" class="size-3.5 shrink-0" />
		{form === 'model' ? m.languageData_thanksModel({ language: name }) : m.languageData_thanks({ language: name })}
	</p>
{/snippet}

{#snippet leaving()}
	<p class="type-caption text-fg-3" data-language-data-leaving>
		{#each m.languageData_leaving({ partners: '{partners}' }).split(/(\{partners\})/).filter(Boolean) as part, p (p)}{#if part === '{partners}'}{#each partners as partner, i (partner)}{#if i > 0}{` ${m.languageData_and()} `}{/if}<OrgMention org={orgs[partner]} />{/each}{:else}{part}{/if}{/each}
	</p>
{/snippet}

{#if layout === 'tiles'}
	<div class="flex flex-col gap-2" data-language-data={language} data-language-data-surface={surface} data-language-data-layout="tiles">
		{#if form === 'none'}
			<div class="grid gap-2 sm:grid-cols-2">
				{#each entry.actions as action (action.id)}
					<HelpTile
						href={partnerHref(action.href, { language, surface })}
						icon={VOICE.has(action.id) ? RiMicLine : RiDatabase2Line}
						title={labelFor(action)}
						hint={hintFor(action)}
						onclick={() => trackEvent('mdc_cta_clicked', { surface, destination: action.id, language })}
						data-language-data-action={action.id}
					>
						<VisuallyHidden>{m.languageData_opensPartner({ partner: DATA_PARTNERS[action.partner].name })}</VisuallyHidden>
					</HelpTile>
				{/each}
				<HelpTile
					icon={RiCpuLine}
					title={modelTitle}
					hint={strongModel ? m.languageData_betterModelHint({ model: strongModel }) : m.languageData_modelTileHint()}
					onclick={() => open('model')}
					data-language-data-model-open
				/>
				{#if offersInterest(entry)}
					<HelpTile
						icon={RiHandHeartLine}
						title={m.languageData_interestTitle()}
						hint={m.languageData_interestHint()}
						onclick={() => open('interest')}
						data-language-data-interest-open
					/>
				{/if}
			</div>
			{#if entry.actions.length && leavingNote}{@render leaving()}{/if}
		{:else}
			<div class="flex flex-col gap-3 rounded-card border border-line-2 bg-surface-1 p-3">
				<Button variant="ghost" size="sm" casing="sentence" class="-ml-2 self-start" onclick={() => (form = 'none')} data-language-data-back>
					<RiArrowLeftLine aria-hidden="true" />
					{m.languageData_back()}
				</Button>
				{#if status === 'sent'}
					{@render thanks()}
				{:else}
					<form bind:this={formEl} class="flex flex-col gap-3" onsubmit={submit} data-language-data-interest={form}>
						{@render formFields()}
					</form>
				{/if}
			</div>
		{/if}
	</div>
{:else}
	<div class="flex flex-col gap-2" data-language-data={language} data-language-data-surface={surface}>
		{#if entry.actions.length}
			<div class="flex flex-wrap items-center gap-1.5">
				{#each entry.actions as action (action.id)}
					<Button
						href={partnerHref(action.href, { language, surface })}
						target="_blank"
						rel="noreferrer"
						size="sm"
						casing="sentence"
						onclick={() => trackEvent('mdc_cta_clicked', { surface, destination: action.id, language })}
						data-language-data-action={action.id}
					>
						{labelFor(action)}
						<VisuallyHidden>{m.languageData_opensPartner({ partner: DATA_PARTNERS[action.partner].name })}</VisuallyHidden>
						<RiArrowRightUpLine aria-hidden="true" />
					</Button>
				{/each}
			</div>
			{@render leaving()}
		{/if}

		{#if status === 'sent'}
			{@render thanks()}
		{:else if form === 'none'}
			<div class="flex flex-wrap items-center gap-x-4 gap-y-1">
				{#if offersInterest(entry)}
					<Button variant="link" size="sm" casing="sentence" onclick={() => open('interest')} data-language-data-interest-open>
						{m.languageData_tellUs({ language: name })}
					</Button>
				{/if}
				<Button variant="link" size="sm" casing="sentence" onclick={() => open('model')} data-language-data-model-open>
					{modelTitle}
				</Button>
			</div>
		{:else}
			<form bind:this={formEl} class="flex flex-col gap-2" onsubmit={submit} data-language-data-interest={form}>
				{@render formFields()}
			</form>
		{/if}
	</div>
{/if}

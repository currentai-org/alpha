<script lang="ts">
	import { base } from '$lib/chat/paths';
	import { Badge } from '@aipotluck/alpha-ds';
	import { orgs, type CatalogModel, type Org } from '$lib/chat/routing/catalog';
	import { RETENTION_DAYS } from '$lib/chat/constants/retention';
	import OrgMention from './OrgMention.svelte';
	import { m } from '$lib/paraglide/messages.js';
	import RiCpuLine from '~icons/ri/cpu-line';
	import RiServerLine from '~icons/ri/server-line';
	import RiSafe2Line from '~icons/ri/safe-2-line';
	import RiDraftLine from '~icons/ri/draft-line';

	/**
	 * The privacy-first transparency breakdown: who made the model, who runs it and where, and where
	 * your data is kept — crediting each organisation by name. Used in the composer (a forecast, before
	 * sending) and for an answer (after).
	 *
	 * States the current associations plainly, straight from `routing/catalog.ts` (`MODEL_HOSTS`,
	 * `DATA_HOME`) — edit them there, not here. A model with no host listed omits that row. An answer
	 * names a host only from its routing record (`ran`), and says when none was recorded (CUR-3562).
	 */
	let {
		model,
		mode = 'forecast',
		ran,
		signedIn = false,
		draftReadBy
	}: {
		model?: CatalogModel;
		mode?: 'forecast' | 'answer';
		/** Where this answer actually ran, from its routing record (`ranOn`); answer mode only (CUR-2921). */
		ran?: { label: string; org?: Org };
		/** A signed-in account's conversations carry no expiry, so it is not told the guest clock (CUR-1731). */
		signedIn?: boolean;
		/** A hosted classifier that reads the draft before it is sent (Auto with `clef-routing` on). */
		draftReadBy?: string;
	} = $props();

	const maker = $derived(model ? orgs[model.maker] : undefined);
	const host = $derived(model?.provider ? orgs[model.provider] : undefined);

	/**
	 * Splits a translated sentence around its markers (`{model}`, `{maker}`, `{host}`, `{link}`) so a
	 * component can stand in each spot while the language keeps its own word order.
	 */
	const around = (text: string, markers: string[]) =>
		text.split(new RegExp(`(${markers.map((k) => k.replace(/[{}]/g, '\\$&')).join('|')})`)).filter(Boolean);
	const modelSentence = $derived(
		around(
			maker?.region
				? m.message_modelMadeByRegion({ model: '{model}', maker: '{maker}', region: maker.region })
				: m.message_modelMadeBy({ model: '{model}', maker: '{maker}' }),
			['{model}', '{maker}']
		)
	);
	const hostSentence = $derived(
		around(
			// The catalogue's planned host, before sending only: an answer names a host from its own
			// routing record (CUR-3562), above.
			host?.region
				? m.message_runsOnIn({ host: '{host}', region: host.region })
				: m.message_runsOn({ host: '{host}' }),
			['{host}']
		)
	);
	const eraseSentence = $derived(around(m.message_dataErase({ link: '{link}' }), ['{link}']));

	const measured = $derived(mode === 'answer' ? ran : undefined);
	const measuredSentence = $derived(
		measured?.org
			? around(
					measured.org.region
						? m.message_ranOnIn({ host: '{host}', region: measured.org.region })
						: m.message_ranOn({ host: '{host}' }),
					['{host}']
				)
			: []
	);
</script>


<dl class="flex flex-col gap-4" data-provenance-breakdown>
	<div class="flex gap-3">
		<RiCpuLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
		<div class="flex min-w-0 flex-col gap-0.5">
			<dt class="type-label text-fg-3">{m.message_stepModelFallback()}</dt>
			<dd class="type-body text-fg-2">
				{#if model && maker}
					<!-- The sentence is translated whole; the model and maker are spliced in where each language puts them. -->
					{#each modelSentence as part, i (i)}{#if part === '{model}'}<span class="text-fg-1">{model.name}</span>{:else if part === '{maker}'}<OrgMention org={maker} />{:else}{part}{/if}{/each}
					{#if maker.public}<span class="ml-1 inline-flex align-middle"><Badge>{m.message_publicResearch()}</Badge></span>{/if}
					<span class="block type-caption text-fg-3">{maker.blurb}</span>
				{:else}
					{m.message_notInCatalogue()}
				{/if}
			</dd>
		</div>
	</div>

	{#if measured}
		<div class="flex gap-3" data-ran-on>
			<RiServerLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
			<div class="flex min-w-0 flex-col gap-0.5">
				<dt class="type-label text-fg-3">{m.message_whereRan()}</dt>
				<dd class="type-body text-fg-2">
					{#if measured.org}
						{#each measuredSentence as part, i (i)}{#if part === '{host}'}<OrgMention org={measured.org} />{:else}{part}{/if}{/each}
					{:else}
						{m.message_ranOn({ host: measured.label })}
					{/if}
					<span class="block type-caption text-fg-3">{m.message_fromRoutingRecord()}</span>
				</dd>
			</div>
		</div>
	{:else if mode === 'answer'}
		<!-- CUR-3562: an answer names a host only from its own routing record. The catalogue's host is
		     where the model is planned to run, and a direct lane or a fallback can serve it elsewhere. -->
		<div class="flex gap-3" data-ran-on="not-recorded">
			<RiServerLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
			<div class="flex min-w-0 flex-col gap-0.5">
				<dt class="type-label text-fg-3">{m.message_whereRan()}</dt>
				<dd class="type-body text-fg-2">{m.message_ranNotRecorded()}</dd>
			</div>
		</div>
	{:else if host}
		<div class="flex gap-3">
			<RiServerLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
			<div class="flex min-w-0 flex-col gap-0.5">
				<dt class="type-label text-fg-3">{m.message_whereRuns()}</dt>
				<dd class="type-body text-fg-2">
					{#each hostSentence as part, i (i)}{#if part === '{host}'}<OrgMention org={host} />{:else}{part}{/if}{/each}
					<!-- The maker's row already carries this blurb when the maker hosts its own model. -->
					{#if host.id !== maker?.id}<span class="block type-caption text-fg-3">{host.blurb}</span>{/if}
				</dd>
			</div>
		</div>
	{/if}

	{#if draftReadBy && mode === 'forecast'}
		<div class="flex gap-3" data-provenance-draft-read>
			<RiDraftLine aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
			<div class="flex min-w-0 flex-col gap-0.5">
				<dt class="type-label text-fg-3">{m.message_beforeYouSend()}</dt>
				<dd class="type-body text-fg-2">
					{m.message_draftReadBy({ classifier: draftReadBy })}
					<span class="block type-caption text-fg-3">
						{m.message_draftReadByNote()}
					</span>
				</dd>
			</div>
		</div>
	{/if}

	<div class="flex gap-3">
		<RiSafe2Line aria-hidden="true" class="mt-0.5 size-4 shrink-0 text-fg-2" />
		<div class="flex min-w-0 flex-col gap-0.5">
			<dt class="type-label text-fg-3">{m.message_yourData()}</dt>
			<dd class="type-body text-fg-2">
				{m.message_dataHome()}
				<span class="block type-caption text-fg-3">
					{signedIn ? m.message_dataKeptSignedIn() : m.message_dataKeptGuest({ days: RETENTION_DAYS })}
					{#each eraseSentence as part, i (i)}{#if part === '{link}'}<a
								href={`${base}/settings/data`}
								class="text-fg-2 underline underline-offset-2 hover:text-fg-1">{m.product_dataPrivacy()}</a
							>{:else}{part}{/if}{/each}
				</span>
			</dd>
		</div>
	</div>
</dl>
